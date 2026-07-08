// SPDX-License-Identifier: MIT
pragma solidity ^0.8.10;

import {IERC20} from '../dependencies/openzeppelin/contracts/IERC20.sol';
import {IERC20Detailed} from '../dependencies/openzeppelin/contracts/IERC20Detailed.sol';
import {ERC20} from '../dependencies/openzeppelin/contracts/ERC20.sol';
import {GPv2SafeERC20} from '../dependencies/gnosis/contracts/GPv2SafeERC20.sol';

/**
 * @title ERC20Wrapper
 * @notice Fixed-rate ERC20 wrapper that exposes 18-decimal shares for a lower-decimal asset.
 */
contract ERC20Wrapper is ERC20 {
  using GPv2SafeERC20 for IERC20;

  IERC20 private immutable _asset;
  uint8 private immutable _assetDecimals;
  uint256 private immutable _shareScale;

  event Deposit(address indexed caller, address indexed receiver, uint256 assets, uint256 shares);
  event Redeem(
    address indexed caller,
    address indexed receiver,
    address indexed owner,
    uint256 assets,
    uint256 shares
  );

  constructor(
    IERC20Detailed asset_,
    string memory name_,
    string memory symbol_
  ) ERC20(name_, symbol_) {
    require(address(asset_) != address(0), 'WRAPPER_ZERO_ASSET');

    uint8 assetDecimals_ = asset_.decimals();
    require(assetDecimals_ <= 18, 'WRAPPER_DECIMALS_GT_18');

    _asset = IERC20(address(asset_));
    _assetDecimals = assetDecimals_;
    _shareScale = 10 ** (18 - assetDecimals_);
    _setupDecimals(18);
  }

  function asset() external view returns (address) {
    return address(_asset);
  }

  function assetDecimals() external view returns (uint8) {
    return _assetDecimals;
  }

  function shareScale() external view returns (uint256) {
    return _shareScale;
  }

  function totalAssets() external view returns (uint256) {
    return _asset.balanceOf(address(this));
  }

  function convertToShares(uint256 assets) public view returns (uint256) {
    return assets * _shareScale;
  }

  function convertToAssets(uint256 shares) public view returns (uint256) {
    return shares / _shareScale;
  }

  function previewDeposit(uint256 assets) external view returns (uint256) {
    return convertToShares(assets);
  }

  function previewWithdraw(uint256 assets) external view returns (uint256) {
    return convertToShares(assets);
  }

  function previewRedeem(uint256 shares) external view returns (uint256) {
    return convertToAssets(shares);
  }

  function deposit(uint256 assets, address receiver) external returns (uint256) {
    uint256 shares = convertToShares(assets);

    _asset.safeTransferFrom(_msgSender(), address(this), assets);
    _mint(receiver, shares);

    emit Deposit(_msgSender(), receiver, assets, shares);

    return shares;
  }

  function withdraw(uint256 assets, address receiver, address owner) external returns (uint256) {
    uint256 shares = convertToShares(assets);
    _redeem(_msgSender(), receiver, owner, assets, shares);

    return shares;
  }

  function redeem(uint256 shares, address receiver, address owner) external returns (uint256) {
    require(shares % _shareScale == 0, 'WRAPPER_NON_WHOLE_ASSET');

    uint256 assets = convertToAssets(shares);
    _redeem(_msgSender(), receiver, owner, assets, shares);

    return assets;
  }

  function _redeem(
    address caller,
    address receiver,
    address owner,
    uint256 assets,
    uint256 shares
  ) internal {
    if (caller != owner) {
      _spendAllowance(owner, caller, shares);
    }

    _burn(owner, shares);
    _asset.safeTransfer(receiver, assets);

    emit Redeem(caller, receiver, owner, assets, shares);
  }

  function _spendAllowance(address owner, address spender, uint256 amount) internal {
    uint256 currentAllowance = allowance(owner, spender);

    if (currentAllowance != type(uint256).max) {
      require(currentAllowance >= amount, 'WRAPPER_INSUFFICIENT_ALLOWANCE');
      _approve(owner, spender, currentAllowance - amount);
    }
  }
}
