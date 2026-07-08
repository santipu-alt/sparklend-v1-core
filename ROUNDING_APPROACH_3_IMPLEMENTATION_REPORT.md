# Approach 3 Rounding Direction Implementation Report

## Summary

Implemented Approach 3 using the least-intrusive variant described in `ROUNDING_MITIGATION_REPORT.md`: an internal `RoundingMode` enum is passed into shared scaled-token accounting helpers.

No persistent storage flag was added, no public Pool/token ABI changed, and no storage layout was changed.

## Implementation Choice

The original Approach 3 describes a short-lived rounding direction flag. This implementation uses the report's safer internal-enum-parameter variant instead of a persistent storage flag because:

- it preserves upgradeable token storage layout;
- it avoids set-and-clear storage writes on hot paths;
- it keeps the rounding mode explicit at each internal call site;
- it still fails closed if shared accounting is called with `INACTIVE`.

## Changes Made

### `contracts/protocol/libraries/math/WadRayMath.sol`

Added explicit ray rounding helpers:

- `rayMulFloor`
- `rayMulCeil`
- `rayDivFloor`
- `rayDivCeil`

The existing half-up `rayMul` and `rayDiv` functions were left unchanged for unrelated protocol math.

### `contracts/protocol/tokenization/base/ScaledBalanceTokenBase.sol`

Added:

- `enum RoundingMode { INACTIVE, ROUND_DOWN, ROUND_UP }`
- `_roundScaledAmount(amount, index, roundingMode)`

Updated shared accounting helpers to require an explicit rounding mode:

- `_mintScaled(..., RoundingMode roundingMode)`
- `_burnScaled(..., RoundingMode roundingMode)`
- `_transfer(..., RoundingMode roundingMode)`

The shared helper reverts with `Errors.INVALID_AMOUNT` if called with `INACTIVE`, so future internal callers cannot silently fall back to half-up conversion.

### `contracts/protocol/tokenization/AToken.sol`

Mapped aToken operations to protocol-pessimistic directions:

- `mint`: `ROUND_DOWN`
- `mintToTreasury`: `ROUND_DOWN`
- `burn`: `ROUND_UP`
- transfers, including liquidation transfers: `ROUND_UP`

Changed aToken visible balance conversions:

- `balanceOf`: `rayMulFloor`
- `totalSupply`: `rayMulFloor`
- transfer pre-balances used by `finalizeTransfer`: `rayMulFloor`

`BalanceTransfer` now emits the actual scaled amount returned by the shared transfer helper.

Effect: supplying/minting cannot credit more unscaled aToken balance than the supplied amount, and withdrawing/transferring burns at least the scaled value of the requested unscaled amount.

### `contracts/protocol/tokenization/VariableDebtToken.sol`

Mapped variable debt operations to protocol-pessimistic directions:

- `mint`: `ROUND_UP`
- `burn`: `ROUND_DOWN`

Changed variable debt visible balance conversions:

- `balanceOf`: `rayMulCeil`
- `totalSupply`: `rayMulCeil`

Effect: borrowing records at least the requested debt, while repay/liquidation burns no more scaled debt than the unscaled repayment amount actually covers.

### `contracts/protocol/libraries/logic/SupplyLogic.sol`

Changed the withdraw-side `userBalance` recomputation from half-up to `rayMulFloor`.

Effect: `withdraw(type(uint256).max)` now uses the same floor-rounded balance exposed by `AToken.balanceOf`, avoiding a max-withdraw request that can ask the new ceil burn to consume one scaled unit too many.

### `contracts/protocol/libraries/logic/GenericLogic.sol`

Changed account-data valuation rounding:

- variable debt scaled balance to unscaled debt: `rayMulCeil`
- debt base-currency conversion: ceil division
- aToken scaled balance to unscaled collateral: `rayMulFloor`
- collateral base-currency conversion remains floor division

Effect: health-factor/account-data math values collateral pessimistically and debt conservatively, reducing user-favoring rounding at the risk boundary.

### `contracts/protocol/libraries/logic/LiquidationLogic.sol`

Changed liquidation protocol-fee scaled pre-check:

- fee amount to scaled fee: `rayDivCeil`
- fallback fee from remaining scaled user balance: `rayMulFloor`

Effect: the pre-check now matches the new aToken liquidation-transfer rounding direction, so the fee path does not pass with half-up math and then revert when the transfer rounds up by one scaled unit.

## How This Fixes The Rounding Issue

The vulnerable boundary is the conversion between unscaled asset amounts and scaled token balances.

For aTokens:

- mint/supply floors scaled shares, so the user cannot receive more claim value than supplied;
- burn/withdraw and transfer ceil scaled shares, so the user cannot redeem or move value without burning enough scaled balance;
- balance and total supply reads floor unscaled value, so displayed/validated collateral is not rounded upward.

For variable debt:

- mint/borrow ceils scaled debt, so the user cannot borrow while recording too little debt;
- burn/repay floors scaled debt, so the user cannot erase more debt than the repayment covers;
- balance and total supply reads ceil unscaled debt, so debt is not rounded downward in user/account-data reads.

For health-factor valuation:

- collateral is rounded down before base-currency valuation;
- variable debt is rounded up before base-currency valuation;
- debt base-currency conversion is rounded up.

Together, these changes remove the user-favoring half-up direction from the high-value scaled accounting paths while preserving the rest of the fork's math behavior.

## Intentionally Unchanged

- No persistent storage flag was added.
- No transient storage was added.
- Public interfaces and Pool/token ABIs were not changed.
- Stable debt token rounding was not changed; the original report calls out stable debt as requiring a separate review if stable borrowing is enabled for high-value, low-decimal assets.
- Existing Certora specs/harnesses were not updated. They still contain old half-up slack assumptions and should be revised in a separate formal-verification pass.
- Broader cap, treasury-accrual, interest-index, flash-loan, and bridge-fee math was left untouched to keep this patch scoped to Approach 3's scaled-token accounting and direct risk valuation boundary.

## Verification

Commands run:

```bash
source ~/.nvm/nvm.sh && nvm use 18.20.8 >/dev/null && npm run compile
```

Result: compile passed.

```bash
source ~/.nvm/nvm.sh && nvm use 18.20.8 >/dev/null && . ./setup-test-env.sh && TS_NODE_TRANSPILE_ONLY=1 npx hardhat test test-suites/__setup.spec.ts test-suites/atoken-edge.spec.ts test-suites/variable-debt-token.spec.ts test-suites/atoken-transfer.spec.ts test-suites/liquidation-with-fee.spec.ts
```

Result: `49 passing`.

Note: running `npm run compile` under the default local Node `v26.2.0` failed before Solidity compilation due to the existing Hardhat/runtime incompatibility: `TypeError: Cannot set property crypto of #<Object> which has only a getter`. Retrying under installed Node `v18.20.8` succeeded.
