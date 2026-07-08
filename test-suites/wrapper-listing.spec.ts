import { expect } from 'chai';
import { BigNumber, utils } from 'ethers';
import { evmRevert, evmSnapshot, waitForTx } from '@aave/deploy-v3';
import { MAX_UINT_AMOUNT, ZERO_ADDRESS } from '../helpers/constants';
import { RateMode } from '../helpers/types';
import { makeSuite, TestEnv } from './helpers/make-suite';
import {
  AToken,
  AToken__factory,
  ERC4626Wrapper,
  ERC4626Wrapper__factory,
  MintableERC20,
  MintableERC20__factory,
  MockReserveInterestRateStrategy__factory,
  StableDebtToken__factory,
  VariableDebtToken,
  VariableDebtToken__factory,
} from '../types';

const RAW_DECIMALS = 6;
const SHARE_SCALE = BigNumber.from(10).pow(18 - RAW_DECIMALS);
const WRAPPER_PRICE = utils.parseUnits('1', 8);

const divUp = (numerator: BigNumber, denominator: BigNumber) =>
  numerator.add(denominator.sub(1)).div(denominator);

makeSuite('Wrapper Listing mitigation', (testEnv: TestEnv) => {
  let rawAsset: MintableERC20;
  let wrapper: ERC4626Wrapper;
  let aWrapper: AToken;
  let variableDebtWrapper: VariableDebtToken;
  let snap: string;

  const deployRawAssetAndWrapper = async (symbol: string) => {
    const { deployer } = testEnv;

    const raw = await new MintableERC20__factory(deployer.signer).deploy(
      `${symbol} raw`,
      symbol,
      RAW_DECIMALS
    );
    const wrapped = await new ERC4626Wrapper__factory(deployer.signer).deploy(
      raw.address,
      `Wrapped ${symbol}`,
      `w${symbol}`
    );

    return { raw, wrapped };
  };

  before(async () => {
    const { addressesProvider, configurator, deployer, oracle, pool, poolAdmin, helpersContract } =
      testEnv;

    const deployed = await deployRawAssetAndWrapper('WLRAW');
    rawAsset = deployed.raw;
    wrapper = deployed.wrapped;

    const stableDebtTokenImplementation = await new StableDebtToken__factory(
      deployer.signer
    ).deploy(pool.address);
    const variableDebtTokenImplementation = await new VariableDebtToken__factory(
      deployer.signer
    ).deploy(pool.address);
    const aTokenImplementation = await new AToken__factory(deployer.signer).deploy(pool.address);
    const mockRateStrategy = await new MockReserveInterestRateStrategy__factory(
      deployer.signer
    ).deploy(addressesProvider.address, 0, 0, 0, 0, 0, 0);

    await waitForTx(
      await configurator.connect(poolAdmin.signer).initReserves([
        {
          aTokenImpl: aTokenImplementation.address,
          stableDebtTokenImpl: stableDebtTokenImplementation.address,
          variableDebtTokenImpl: variableDebtTokenImplementation.address,
          underlyingAssetDecimals: 18,
          interestRateStrategyAddress: mockRateStrategy.address,
          underlyingAsset: wrapper.address,
          treasury: ZERO_ADDRESS,
          incentivesController: ZERO_ADDRESS,
          aTokenName: 'Aave wrapped listing raw',
          aTokenSymbol: 'aWLRAW',
          variableDebtTokenName: 'Aave variable debt wrapped listing raw',
          variableDebtTokenSymbol: 'variableDebtWLRAW',
          stableDebtTokenName: 'Aave stable debt wrapped listing raw',
          stableDebtTokenSymbol: 'stableDebtWLRAW',
          params: '0x10',
        },
      ])
    );

    await waitForTx(await oracle.setAssetPrice(wrapper.address, WRAPPER_PRICE));
    await waitForTx(
      await configurator
        .connect(poolAdmin.signer)
        .configureReserveAsCollateral(wrapper.address, 7000, 7500, 10500)
    );
    await waitForTx(
      await configurator.connect(poolAdmin.signer).setReserveBorrowing(wrapper.address, true)
    );

    const reserveTokens = await helpersContract.getReserveTokensAddresses(wrapper.address);
    aWrapper = AToken__factory.connect(reserveTokens.aTokenAddress, deployer.signer);
    variableDebtWrapper = VariableDebtToken__factory.connect(
      reserveTokens.variableDebtTokenAddress,
      deployer.signer
    );
  });

  beforeEach(async () => {
    snap = await evmSnapshot();
  });

  afterEach(async () => {
    await evmRevert(snap);
  });

  it('uses ERC4626 rounding with 18-decimal shares', async () => {
    const { users } = testEnv;
    const user = users[0];
    const deployed = await deployRawAssetAndWrapper('ROUND');
    const raw = deployed.raw;
    const wrapped = deployed.wrapped;

    expect(await wrapped.decimals()).to.be.eq(18);
    expect(await wrapped.assetDecimals()).to.be.eq(RAW_DECIMALS);
    expect(await wrapped.shareScale()).to.be.eq(SHARE_SCALE);
    expect(await wrapped.previewDeposit(1)).to.be.eq(SHARE_SCALE);
    expect(await wrapped.previewWithdraw(1)).to.be.eq(SHARE_SCALE);
    expect(await wrapped.previewRedeem(1)).to.be.eq(0);

    await waitForTx(await raw.connect(user.signer)['mint(address,uint256)'](user.address, 3));
    await waitForTx(await raw.connect(user.signer).approve(wrapped.address, MAX_UINT_AMOUNT));
    await waitForTx(await wrapped.connect(user.signer).deposit(1, user.address));

    expect(await wrapped.balanceOf(user.address)).to.be.eq(SHARE_SCALE);
    expect(await wrapped.convertToAssets(SHARE_SCALE)).to.be.eq(1);

    await waitForTx(await raw.connect(user.signer).transfer(wrapped.address, 1));

    const expectedDepositShares = SHARE_SCALE.mul(2).div(3);
    const expectedWithdrawShares = divUp(SHARE_SCALE.mul(2), BigNumber.from(3));

    expect(await wrapped.previewDeposit(1)).to.be.eq(expectedDepositShares);
    expect(await wrapped.previewWithdraw(1)).to.be.eq(expectedWithdrawShares);
  });

  it('can be listed as the Pool reserve while the raw low-decimal asset stays unlisted', async () => {
    const { pool, users } = testEnv;
    const user = users[1];

    await waitForTx(await rawAsset.connect(user.signer)['mint(address,uint256)'](user.address, 1));
    await waitForTx(await rawAsset.connect(user.signer).approve(wrapper.address, MAX_UINT_AMOUNT));
    await waitForTx(await wrapper.connect(user.signer).deposit(1, user.address));

    expect(await wrapper.balanceOf(user.address)).to.be.eq(SHARE_SCALE);

    await waitForTx(await wrapper.connect(user.signer).approve(pool.address, MAX_UINT_AMOUNT));
    await waitForTx(
      await pool.connect(user.signer).deposit(wrapper.address, SHARE_SCALE, user.address, 0)
    );

    expect(await aWrapper.balanceOf(user.address)).to.be.eq(SHARE_SCALE);

    const listedReserves = await pool.getReservesList();
    expect(listedReserves).to.include(wrapper.address);
    expect(listedReserves).to.not.include(rawAsset.address);

    await waitForTx(await pool.connect(user.signer).withdraw(wrapper.address, 1, user.address));

    const rawBalanceBeforeDustRedeem = await rawAsset.balanceOf(user.address);
    expect(await wrapper.balanceOf(user.address)).to.be.eq(1);
    expect(await wrapper.previewRedeem(1)).to.be.eq(0);

    await waitForTx(await wrapper.connect(user.signer).redeem(1, user.address, user.address));

    expect(await rawAsset.balanceOf(user.address)).to.be.eq(rawBalanceBeforeDustRedeem);
  });

  it('supports variable borrow and repay in wrapper-share units', async () => {
    const { dai, pool, users } = testEnv;
    const liquidityProvider = users[2];
    const borrower = users[3];
    const rawLiquidity = utils.parseUnits('1000', RAW_DECIMALS);
    const wrapperLiquidity = await wrapper.previewDeposit(rawLiquidity);
    const borrowAmount = utils.parseEther('10');

    await waitForTx(
      await rawAsset
        .connect(liquidityProvider.signer)
        ['mint(address,uint256)'](liquidityProvider.address, rawLiquidity)
    );
    await waitForTx(
      await rawAsset.connect(liquidityProvider.signer).approve(wrapper.address, MAX_UINT_AMOUNT)
    );
    await waitForTx(
      await wrapper
        .connect(liquidityProvider.signer)
        .deposit(rawLiquidity, liquidityProvider.address)
    );
    await waitForTx(
      await wrapper.connect(liquidityProvider.signer).approve(pool.address, MAX_UINT_AMOUNT)
    );
    await waitForTx(
      await pool
        .connect(liquidityProvider.signer)
        .deposit(wrapper.address, wrapperLiquidity, liquidityProvider.address, 0)
    );

    await waitForTx(
      await dai
        .connect(borrower.signer)
        ['mint(address,uint256)'](borrower.address, utils.parseEther('1000'))
    );
    await waitForTx(await dai.connect(borrower.signer).approve(pool.address, MAX_UINT_AMOUNT));
    await waitForTx(
      await pool
        .connect(borrower.signer)
        .deposit(dai.address, utils.parseEther('1000'), borrower.address, 0)
    );

    await waitForTx(
      await pool
        .connect(borrower.signer)
        .borrow(wrapper.address, borrowAmount, RateMode.Variable, 0, borrower.address)
    );

    expect(await wrapper.balanceOf(borrower.address)).to.be.eq(borrowAmount);
    expect(await rawAsset.balanceOf(aWrapper.address)).to.be.eq(0);
    expect(await variableDebtWrapper.balanceOf(borrower.address)).to.be.eq(borrowAmount);
    expect(await wrapper.previewRedeem(1)).to.be.eq(0);

    await waitForTx(await wrapper.connect(borrower.signer).approve(pool.address, MAX_UINT_AMOUNT));
    await waitForTx(
      await pool
        .connect(borrower.signer)
        .repay(wrapper.address, borrowAmount, RateMode.Variable, borrower.address)
    );

    expect(await variableDebtWrapper.balanceOf(borrower.address)).to.be.eq(0);
  });

  it('supports wrapper shares as collateral for borrowing another reserve', async () => {
    const { dai, pool, users } = testEnv;
    const daiLiquidityProvider = users[4];
    const borrower = users[5];
    const rawCollateral = utils.parseUnits('100', RAW_DECIMALS);
    const wrapperCollateral = await wrapper.previewDeposit(rawCollateral);
    const borrowAmount = utils.parseEther('50');

    await waitForTx(
      await dai
        .connect(daiLiquidityProvider.signer)
        ['mint(address,uint256)'](daiLiquidityProvider.address, utils.parseEther('1000'))
    );
    await waitForTx(
      await dai.connect(daiLiquidityProvider.signer).approve(pool.address, MAX_UINT_AMOUNT)
    );
    await waitForTx(
      await pool
        .connect(daiLiquidityProvider.signer)
        .deposit(dai.address, utils.parseEther('1000'), daiLiquidityProvider.address, 0)
    );

    await waitForTx(
      await rawAsset
        .connect(borrower.signer)
        ['mint(address,uint256)'](borrower.address, rawCollateral)
    );
    await waitForTx(
      await rawAsset.connect(borrower.signer).approve(wrapper.address, MAX_UINT_AMOUNT)
    );
    await waitForTx(
      await wrapper.connect(borrower.signer).deposit(rawCollateral, borrower.address)
    );
    await waitForTx(await wrapper.connect(borrower.signer).approve(pool.address, MAX_UINT_AMOUNT));
    await waitForTx(
      await pool
        .connect(borrower.signer)
        .deposit(wrapper.address, wrapperCollateral, borrower.address, 0)
    );

    await waitForTx(
      await pool
        .connect(borrower.signer)
        .borrow(dai.address, borrowAmount, RateMode.Variable, 0, borrower.address)
    );

    const accountData = await pool.getUserAccountData(borrower.address);

    expect(await dai.balanceOf(borrower.address)).to.be.eq(borrowAmount);
    expect(accountData.totalCollateralBase).to.be.gt(0);
    expect(accountData.totalDebtBase).to.be.gt(0);
  });
});
