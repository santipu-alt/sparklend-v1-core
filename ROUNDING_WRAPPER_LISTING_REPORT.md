# Wrapper Listing Rounding Mitigation Report

## Scope

This report explores the "Wrapper Listing" alternative from `ROUNDING_MITIGATION_REPORT.md`.
The question was whether high-value, low-decimal assets can be listed through an
18-decimal wrapper without changing SparkLend/Aave core protocol code, and whether
that makes the known half-up scaled-accounting rounding issue non-exploitable in
practice.

## Changes Made

No core protocol files were changed. The existing Pool, configurator, aToken, debt
token, math, liquidation, and generic logic contracts were left untouched.

Added files:

- `contracts/misc/ERC4626Wrapper.sol`

  - A thin wrapper around OpenZeppelin Contracts `4.9.6` `ERC4626`.
  - Keeps the local code limited to selecting an 18-decimal share offset for
    lower-decimal assets.
  - Exposes 18-decimal wrapper shares for underlying assets with decimals `<= 18`.
  - Inherits OpenZeppelin's ERC-4626 conversion directions:
    - `deposit`: shares round down.
    - `mint`: assets round up.
    - `withdraw`: shares round up.
    - `redeem`: assets round down.
  - Inherits OpenZeppelin's virtual asset/share offset pattern so an empty
    6-decimal asset wrapper maps `1` raw underlying unit to `1e12` wrapper share
    wei.

- `test-suites/wrapper-listing.spec.ts`
  - Adds focused wrapper tests and integration tests against the current Pool.

Updated dependency metadata:

- `package.json`
- `package-lock.json`

These add `@openzeppelin/contracts@4.9.6`, the latest OpenZeppelin Contracts line
compatible with this repo's Solidity `0.8.10` compiler target. OpenZeppelin
Contracts `5.x` requires a newer Solidity compiler.

## Feasibility

This approach is technically feasible without core protocol changes.

The tests initialize a new reserve where the listed Pool asset is the wrapper token,
not the raw 6-decimal token. The reserve is configured through the existing
`PoolConfigurator.initReserves`, `configureReserveAsCollateral`, and
`setReserveBorrowing` paths. The raw underlying asset never appears in
`Pool.getReservesList()`.

That means the core protocol only ever accounts in wrapper share units. The existing
half-up rounding behavior still exists, but its smallest unit is now `1` wrapper
share wei instead of `1` raw low-decimal asset unit.

## Mitigation Assessment

Wrapper listing does not fix the core bug. Any directly listed high-value,
low-decimal reserve remains exposed.

For a correctly listed wrapper market, it should mitigate the issue so the known
rounding leak is no longer economically exploitable:

- For an underlying with `d` decimals, `1` raw unit maps to `10 ** (18 - d)` wrapper
  share wei.
- For a 6-decimal asset, `1` raw unit maps to `1e12` wrapper share wei.
- A one-unit Pool rounding error is therefore one wrapper share wei.
- `previewRedeem(1)` returns `0` raw units in the test wrapper.
- To redeem one raw unit, an attacker would need to accumulate `10 ** (18 - d)`
  wrapper share wei, while paying for many protocol operations.

So the exploit surface is reduced from "one valuable raw asset unit per favorable
rounding" to "one 18-decimal share wei per favorable rounding." That is the intended
economic mitigation.

## Tests

Command used:

```bash
source ~/.nvm/nvm.sh && nvm use 18.20.8 && MARKET_NAME=Test ENABLE_REWARDS=false TS_NODE_TRANSPILE_ONLY=1 npx hardhat test test-suites/__setup.spec.ts test-suites/wrapper-listing.spec.ts
```

Result:

```text
4 passing
```

Notes:

- The repo's Hardhat stack failed under Node `v26.2.0` because an older
  `defender-base-client` dependency tries to assign `global.crypto`.
- Node `v18.20.8` worked.

Test coverage added:

- Wrapper conversion and ERC-4626 rounding:
  - 18-decimal shares.
  - 6-decimal raw asset maps `1` raw unit to `1e12` share wei.
  - `previewRedeem(1) == 0`.
  - Donation-induced non-integer exchange rate rounds deposits down and withdrawals
    up.
- Pool reserve listing:
  - Wrapper can be initialized as a reserve through the existing configurator.
  - Raw low-decimal asset is not listed.
  - Supplying wrapper shares to the Pool and withdrawing one wrapper share wei works.
  - Redeeming that one wrapper share wei extracts zero raw underlying units.
- Borrow/repay:
  - Wrapper reserve can be borrowed at variable rate.
  - Variable debt is denominated in wrapper share units.
  - Repayment clears the wrapper-denominated variable debt.
- Collateral:
  - Wrapper shares can be configured as collateral.
  - A user can deposit wrapper collateral and borrow another reserve.
  - Account data reports non-zero collateral and debt through existing health-factor
    valuation paths.

## Edge Cases And Requirements

Raw asset must not remain listed. If the raw low-decimal asset is active as collateral
or borrowable debt, the original issue is still present on that reserve.

Existing direct markets need migration. For an already-listed asset, the safe path is
to freeze or disable the risky side, migrate users/liquidity into the wrapper reserve,
then unlist the raw reserve or keep it non-collateral and non-borrowable.

Oracle design is critical. The test uses a static mock price because the tested
wrapper flow has a 1:1 decimal-normalized exchange rate. This wrapper inherits
OpenZeppelin ERC4626 and `totalAssets()` includes direct underlying transfers, so
donations or yield can increase share price. For a borrowable production reserve,
use either:

- a dynamic oracle that prices one wrapper share through `convertToAssets`, or
- a stricter fixed-rate wrapper design with explicit donation/surplus handling.

Static 1:1 pricing is not enough for a borrowable wrapper if share price can move.
It can understate wrapper-denominated debt after donations or yield.

Underlying token assumptions matter. The wrapper assumes a standard, non-rebasing,
non-fee-on-transfer ERC-20. Fee-on-transfer assets can make the wrapper over-mint.
Rebasing or balance-mutating assets can move share price unexpectedly.

Stable borrowing remains a separate review item. The tests intentionally cover
variable debt. If stable borrowing is enabled for a wrapper reserve, stable debt
rounding and accrual should be reviewed separately.

Dust UX needs care. A user can redeem tiny share dust for zero raw assets. This is
conservative and protects the wrapper, but frontends and integrations should avoid
offering zero-asset redemptions as useful actions.

Liquidation-specific rounding was not separately fuzzed here. The core liquidation
math still rounds as before, but with wrapper share wei as the accounting unit. That
should make one-unit liquidation/accounting errors economically negligible, but a
production rollout should include liquidation scenarios for the exact reserve
configuration and oracle.

## Conclusion

Wrapper listing is viable as an asset-onboarding or migration mitigation and can be
implemented without touching core protocol contracts. The focused tests confirm that
the current system can list, supply, borrow, repay, and use the wrapper as collateral.

It should be treated as an economic containment strategy, not a protocol-level fix.
It is only safe if the raw high-value, low-decimal asset is not directly active in the
Pool and the wrapper/oracle combination is reviewed as part of the listed asset.
