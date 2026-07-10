# Rounding Direction Flag Mitigation Report

## Scope

This repository is a SparkLend fork based on older Aave V3 code. The implemented mitigation addresses the high-value, low-decimal asset rounding issue handled by Aave v3.5 without importing the complete Aave 3.1-3.7 upgrade history.

The fix is focused on the scaled-accounting and risk-valuation boundaries used by aTokens and variable debt tokens:

- unscaled asset amount to scaled balance: `amount / index`;
- scaled balance to unscaled balance: `scaledBalance * index`;
- asset amount to base-currency value: `amount * price / assetUnit`.

## Problem

The original fork used half-up rounding for ray arithmetic. In `WadRayMath`, `rayMul` adds `HALF_RAY` before division and `rayDiv` adds half of the divisor before division. Consequently, conversions between asset amounts and scaled balances can round either in favor of the user or in favor of the protocol depending on the reserve index and the exact amount.

For an 18-decimal asset, a one-wei discrepancy is normally economically negligible. For a high-value, low-decimal asset such as a WBTC- or XAUT-like asset, one smallest unit can have meaningful value. Repeated supply, withdrawal, transfer, borrow, repay, or liquidation operations can therefore turn a one-unit user-favoring rounding error into an extractable loop.

The protocol needs deterministic, pessimistic rounding at each accounting boundary:

| Operation                              | Required direction | Safety property                                                    |
| -------------------------------------- | ------------------ | ------------------------------------------------------------------ |
| aToken mint/supply                     | Down               | The user is not credited with more claim value than supplied.      |
| aToken burn/withdraw                   | Up                 | The user burns enough scaled balance for the amount withdrawn.     |
| aToken transfer                        | Up                 | The sender burns enough scaled balance for the amount transferred. |
| aToken balance and total supply        | Down               | Collateral is not exposed or valued above its scaled claim.        |
| Variable debt mint/borrow              | Up                 | The recorded debt is not smaller than the amount borrowed.         |
| Variable debt burn/repay               | Down               | Repayment does not erase more scaled debt than it covers.          |
| Variable debt balance and total supply | Up                 | Debt is not exposed or valued below its scaled obligation.         |
| Collateral base-currency valuation     | Down               | Account collateral is not overstated.                              |
| Debt base-currency valuation           | Up                 | Account debt is not understated.                                   |

## Resources

### Upstream references

- [Aave v3.5 feature document](https://github.com/aave-dao/aave-v3-origin/blob/main/docs/3.5/Aave-v3.5-features.md)
- [Aave v3.5.0 source](https://github.com/aave-dao/aave-v3-origin/tree/v3.5.0)
- [Aave v3.4.0 pre-change source](https://github.com/aave-dao/aave-v3-origin/tree/v3.4.0)
- [Aave v3.5 TokenMath](https://github.com/aave-dao/aave-v3-origin/blob/v3.5.0/src/contracts/protocol/libraries/helpers/TokenMath.sol)
- [Aave v3.5 WadRayMath](https://github.com/aave-dao/aave-v3-origin/blob/v3.5.0/src/contracts/protocol/libraries/math/WadRayMath.sol)
- Aave v3.5 token implementations: `AToken.sol`, `VariableDebtToken.sol`, `ScaledBalanceTokenBase.sol`, and `IncentivizedERC20.sol`
- Aave v3.5 protocol logic: `SupplyLogic.sol`, `BorrowLogic.sol`, `ValidationLogic.sol`, `GenericLogic.sol`, `ReserveLogic.sol`, and `LiquidationLogic.sol`

### Relevant local files

- `contracts/protocol/libraries/math/WadRayMath.sol`
- `contracts/protocol/tokenization/base/ScaledBalanceTokenBase.sol`
- `contracts/protocol/tokenization/AToken.sol`
- `contracts/protocol/tokenization/VariableDebtToken.sol`
- `contracts/protocol/libraries/logic/SupplyLogic.sol`
- `contracts/protocol/libraries/logic/GenericLogic.sol`
- `contracts/protocol/libraries/logic/LiquidationLogic.sol`
- `certora/specs/AToken.spec` and `certora/specs/VariableDebtToken.spec`, which still model the previous half-up rounding slack and require a separate formal-verification update

## Chosen Approach: Rounding Direction Flag

The chosen design represents the rounding context with an internal enum and passes it explicitly into the shared scaled-token accounting functions:

```solidity
enum RoundingMode {
  INACTIVE,
  ROUND_DOWN,
  ROUND_UP
}
```

Each token entry point selects the required direction before invoking shared mint, burn, or transfer accounting. The shared conversion function consumes that explicit mode and reverts if it receives `INACTIVE`.

The term _flag_ describes the operation-specific direction, but the flag is passed as an internal function argument rather than stored in contract state. It is therefore short-lived, visible at each call site, and cannot remain active across an external call.

### Rationale

This approach was selected because it provides the required operation-specific rounding while keeping the patch narrow and compatible with the existing fork:

- It preserves the public Pool, aToken, and variable debt token ABIs.
- It does not add a state variable and therefore does not change upgradeable-token storage layouts.
- It avoids state set-and-clear gas costs on common mint, burn, and transfer paths.
- It makes each rounding decision explicit at the call site, which improves auditability.
- It centralizes the conversion logic instead of duplicating separate up/down mint, burn, and transfer helpers.
- It fails closed: a future shared-accounting caller that supplies `INACTIVE` cannot silently fall back to half-up rounding.
- It leaves existing half-up ray functions intact for unrelated protocol math, limiting behavioral change to the vulnerable boundaries.

A persistent storage flag was not used because storage added to `ScaledBalanceTokenBase` could shift child-contract storage, while leaf-level flags would require hooks or duplicated state handling. Persistent state would also introduce extra gas and hidden mutable context. Transient storage was not used because the repository targets Solidity `0.8.10` and the London EVM, where it is unavailable without a broader compiler and deployment-target migration.

## Implementation Details

### Explicit floor and ceiling ray math

`contracts/protocol/libraries/math/WadRayMath.sol` adds four helpers:

- `rayMulFloor`;
- `rayMulCeil`;
- `rayDivFloor`;
- `rayDivCeil`.

The original half-up `rayMul` and `rayDiv` functions remain unchanged for protocol calculations outside the scope of this mitigation.

### Shared scaled-balance accounting

`contracts/protocol/tokenization/base/ScaledBalanceTokenBase.sol` defines `RoundingMode` and adds `_roundScaledAmount(amount, index, roundingMode)`.

The shared functions now require a rounding mode:

- `_mintScaled(..., RoundingMode roundingMode)`;
- `_burnScaled(..., RoundingMode roundingMode)`;
- `_transfer(..., RoundingMode roundingMode)`.

`_roundScaledAmount` selects `rayDivFloor` for `ROUND_DOWN`, selects `rayDivCeil` for `ROUND_UP`, and reverts with `Errors.INVALID_AMOUNT` for `INACTIVE`. The transfer helper returns the actual scaled amount moved so callers can report it consistently.

### aToken mapping

`contracts/protocol/tokenization/AToken.sol` applies the following directions:

- `mint`: `ROUND_DOWN`;
- `mintToTreasury`: `ROUND_DOWN`;
- `burn`: `ROUND_UP`;
- ordinary transfers: `ROUND_UP`;
- liquidation transfers: `ROUND_UP`.

The visible balance conversions were also changed:

- `balanceOf` uses `rayMulFloor`;
- `totalSupply` uses `rayMulFloor`;
- the pre-transfer balances sent to `Pool.finalizeTransfer` use `rayMulFloor`.

`BalanceTransfer` emits the actual scaled amount returned by the shared transfer helper. Together, these changes prevent supply from over-crediting a user and ensure that withdrawal or transfer consumes enough scaled balance for the requested asset amount.

### Variable debt mapping

`contracts/protocol/tokenization/VariableDebtToken.sol` applies the opposite debt-safe directions:

- `mint`: `ROUND_UP`;
- `burn`: `ROUND_DOWN`;
- `balanceOf`: `rayMulCeil`;
- `totalSupply`: `rayMulCeil`.

Borrowing therefore records at least the requested debt, while repayment or liquidation cannot erase more scaled debt than the paid amount covers.

### Maximum-withdraw alignment

`contracts/protocol/libraries/logic/SupplyLogic.sol` recomputes the withdraw-side user balance with `rayMulFloor`.

This keeps `withdraw(type(uint256).max)` aligned with the floor-rounded value returned by `AToken.balanceOf`. Without this alignment, the maximum-withdraw path could request an amount that makes the new ceiling burn attempt to consume one scaled unit more than the user owns.

### Account-data valuation

`contracts/protocol/libraries/logic/GenericLogic.sol` now applies risk-pessimistic rounding when calculating account data:

- scaled variable debt is converted to unscaled debt with `rayMulCeil`;
- total debt is converted to base currency with ceiling division;
- scaled aToken collateral is converted to an unscaled balance with `rayMulFloor`;
- collateral-to-base-currency conversion remains floor division.

As a result, health-factor calculations do not overstate collateral or understate debt at rounding boundaries.

### Liquidation protocol-fee alignment

`contracts/protocol/libraries/logic/LiquidationLogic.sol` converts the liquidation protocol fee to scaled units with `rayDivCeil`, matching the aToken liquidation transfer's `ROUND_UP` direction. If the required fee exceeds the user's remaining scaled collateral, the fallback unscaled fee is derived with `rayMulFloor`.

This prevents the fee pre-check from passing with a smaller half-up value and then reverting when the actual liquidation transfer rounds up by one scaled unit.

## Security Effect

The mitigation removes user-favoring half-up rounding from the affected scaled-accounting loop:

1. Supplying cannot mint excess aToken claim value.
2. Withdrawing or transferring cannot release value without consuming enough scaled aTokens.
3. Borrowing cannot record less variable debt than the value received.
4. Repayment cannot cancel more variable debt than the payment covers.
5. Collateral and debt reads use the same pessimistic directions in account-data calculations.

The result is a consistent protocol-favoring invariant at the relevant boundaries, while unrelated interest-index, flash-loan, bridge-fee, and general percentage math retain their existing behavior.

## Scope Boundaries and Follow-up Work

- Stable debt rounding was not changed. If stable-rate borrowing is enabled for a high-value, low-decimal asset, it requires a separate pessimistic-rounding review.
- Public interfaces and Pool/token ABIs were not changed.
- No persistent or transient storage was added.
- Broader cap, treasury-accrual, interest-index, flash-loan, and bridge-fee math was intentionally left outside this patch.
- Existing Certora specifications and harness assumptions were not updated and should be revised to assert the new exact floor/ceiling properties.
