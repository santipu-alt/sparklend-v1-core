# Rounding Flag Approach Report

## Scope

This report documents the Approach 3 implementation: a short-lived rounding mode stored in token storage and consumed by shared scaled-token accounting.

Reference implementation reviewed:

`https://github.com/tonicertora/sparklend-v1-core/commit/7016779f3d432d22cef5e3f46cc9886fbfa16b6b`

The local implementation intentionally keeps the change smaller than that reference:

- no public `setRounding` function
- no `IScaledBalanceToken`, `IAToken`, or `IVariableDebtToken` ABI change
- no Pool, BorrowLogic, BridgeLogic, or PoolLogic flag-setting calls
- no ordinary Solidity storage variable added to upgradeable token inheritance

## Design

`ScaledBalanceTokenBase` now owns an internal enum:

- `INACTIVE`
- `ROUND_DOWN`
- `ROUND_UP`

The enum value is stored in an unstructured storage slot:

`keccak256("sparklend.scaledBalanceToken.rounding") - 1`

This avoids shifting the existing proxy storage layout of `AToken` and `VariableDebtToken`. The flag is internal-only and is set by concrete token entry points immediately before they call shared scaled accounting.

The shared scaled operations consume the flag and reset it to `INACTIVE` before calling `_mint`, `_burn`, or `super._transfer`, which can trigger incentives controller hooks. If shared scaled accounting is reached without an active flag, it reverts with `Errors.INACTIVE_ROUNDING`.

## Changes

### `contracts/protocol/libraries/math/WadRayMath.sol`

Added explicit opt-in helpers:

- `rayMulFloor`
- `rayMulCeil`
- `rayDivFloor`
- `rayDivCeil`

The existing half-up `rayMul` and `rayDiv` functions are unchanged so interest-rate math and unrelated protocol calculations keep their previous behavior.

### `contracts/protocol/tokenization/base/ScaledBalanceTokenBase.sol`

Added the internal rounding flag and consumption helpers.

Changed shared scaled conversions:

- `_mintScaled`: converts `amount / index` using the active flag.
- `_burnScaled`: converts `amount / index` using the active flag.
- `_transfer`: converts `amount / index` using the active flag and returns the actual scaled amount transferred.

The fail-closed behavior prevents future internal callers from accidentally using half-up scaled division without first selecting a direction.

### `contracts/protocol/tokenization/AToken.sol`

Set the flag at aToken entry points:

- `mint`: `ROUND_DOWN`
- `burn`: `ROUND_UP`
- `mintToTreasury`: `ROUND_DOWN`
- `_transfer`: `ROUND_UP`, covering normal transfers, `transferFrom`, and liquidation transfers

Changed aToken read rounding:

- `balanceOf`: `rayMulFloor`
- `totalSupply`: `rayMulFloor`
- pre-transfer balances passed to `Pool.finalizeTransfer`: `rayMulFloor`

Changed `BalanceTransfer` to emit the actual scaled amount moved by the shared transfer helper.

Effect:

- supplying cannot mint more scaled aTokens than the supplied assets justify
- withdrawing must burn enough scaled aTokens to cover the requested assets
- transferring aTokens cannot move fewer scaled shares than the requested unscaled amount requires
- visible collateral balances do not round up in favor of users

### `contracts/protocol/tokenization/VariableDebtToken.sol`

Set the flag at variable debt entry points:

- `mint`: `ROUND_UP`
- `burn`: `ROUND_DOWN`

Changed variable debt read rounding:

- `balanceOf`: `rayMulCeil`
- `totalSupply`: `rayMulCeil`

Effect:

- borrowing records at least the requested debt
- repay/liquidation debt burns do not burn more debt shares than the repaid amount covers
- visible variable debt does not round down in favor of borrowers

### `contracts/protocol/libraries/logic/SupplyLogic.sol`

Changed withdraw user balance calculation to call `IAToken.balanceOf`.

This avoids the old manual `scaledBalanceOf(...).rayMul(...)` half-up path. It also keeps `withdraw(type(uint256).max)` aligned with the new aToken floor balance, so max withdraw does not try to burn one scaled unit too many.

### `contracts/protocol/libraries/logic/LiquidationLogic.sol`

Changed the liquidation protocol-fee aToken transfer pre-check:

- fee amount to scaled amount: `rayDivCeil`
- max transferable fee amount: `rayMulFloor`

This matches the new rounded-up aToken transfer scaling. Without this, the pre-check could pass while `transferOnLiquidation` reverts by one scaled unit.

### `contracts/protocol/libraries/logic/GenericLogic.sol`

Changed gas-optimized valuation paths that bypass token `balanceOf`:

- variable debt scaled balance to unscaled debt: `rayMulCeil`
- debt base-currency conversion: ceil division
- collateral scaled balance to unscaled balance: `rayMulFloor`

Effect:

- health-factor collateral valuation rounds down
- health-factor variable debt valuation rounds up

### `contracts/protocol/libraries/helpers/Errors.sol`

Added:

- `INACTIVE_ROUNDING = '92'`

### `helpers/types.ts`

Added the matching TypeScript test/helper enum entry for `INACTIVE_ROUNDING`.

## Why This Fixes The Rounding Issue

The vulnerable boundary is the conversion between unscaled token amounts and scaled accounting shares:

- scaled aToken shares are minted or burned as `amount / liquidityIndex`
- scaled variable debt shares are minted or burned as `amount / variableBorrowIndex`

Half-up rounding can favor the user in some states. The new flag makes the direction operation-specific:

| Operation                            | Direction | Reason                                        |
| ------------------------------------ | --------- | --------------------------------------------- |
| aToken mint/supply                   | down      | user receives no more claim than supplied     |
| aToken burn/withdraw                 | up        | user burns enough claim for assets withdrawn  |
| aToken transfer/liquidation transfer | up        | sender parts with enough scaled claim         |
| variable debt mint/borrow            | up        | borrower records at least requested debt      |
| variable debt burn/repay/liquidation | down      | repaid amount cannot erase excess debt shares |
| aToken balance reads                 | down      | collateral/claim value is not overstated      |
| variable debt balance reads          | up        | debt value is not understated                 |

The flag is reset before external hooks or callbacks, so no public/external token path should leave hidden rounding context active after the scaled operation has completed.

## What Was Intentionally Not Changed

Stable debt rounding is unchanged. The original mitigation report already notes that stable debt needs a separate review if high-value, low-decimal assets can be borrowed at stable rate.

Global `rayMul` and `rayDiv` behavior is unchanged. A global rounding change would be unsafe because different accounting contexts require opposite directions.

Pool and token interfaces are unchanged. This keeps integrations compiled against the old ABI compatible with this patch.

Supply-cap and borrow-cap math is not fully redesigned into v3.5-style scaled cap checks. The health-factor valuation paths were updated because they directly bypassed token balances; cap logic can be handled as a follow-up if the team wants to continue beyond the least-intrusive Approach 3 patch.

## Verification

Commands run with Node `v18.20.8` because the default local Node `v26.2.0` is not supported by this Hardhat stack.

```bash
source ~/.nvm/nvm.sh && nvm use 18.20.8 >/dev/null && npm run compile
```

Result: compiled successfully.

```bash
source ~/.nvm/nvm.sh && nvm use 18.20.8 >/dev/null && . ./setup-test-env.sh && TS_NODE_TRANSPILE_ONLY=1 npx hardhat test test-suites/__setup.spec.ts test-suites/atoken-edge.spec.ts test-suites/atoken-transfer.spec.ts test-suites/variable-debt-token.spec.ts test-suites/liquidation-with-fee.spec.ts test-suites/wadraymath.spec.ts
```

Result: 56 passing.

```bash
git diff --check
```

Result: no whitespace errors.
