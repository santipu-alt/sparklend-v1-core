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

- `contracts/misc/ERC20Wrapper.sol`

  - A fixed-rate wrapper built on the repo's vendored `ERC20`.
  - Uses the repo's vendored `GPv2SafeERC20` for underlying transfers.
  - Exposes 18-decimal wrapper shares for underlying assets with decimals `<= 18`.
  - Mints and redeems at a fixed whole-token 1:1 rate:
    - `shares = assets * 10 ** (18 - underlyingDecimals)`.
    - `assets = shares / 10 ** (18 - underlyingDecimals)`.
  - Rejects redemption of wrapper dust that is not an exact multiple of the
    scale factor.

- `test-suites/wrapper-listing.spec.ts`
  - Adds focused wrapper tests and integration tests against the current Pool.

Updated dependency metadata:

- `package.json`
- `package-lock.json`

These remove the previously added `@openzeppelin/contracts` dependency. The wrapper
now uses only dependencies already vendored in this repository.

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
- `previewRedeem(1)` returns `0` raw units in the test wrapper, and `redeem(1)`
  reverts because one wrapper wei is not a whole raw-asset unit.
- To redeem one raw unit, an attacker would need to accumulate `10 ** (18 - d)`
  wrapper share wei, while paying for many protocol operations.

So the exploit surface is reduced from "one valuable raw asset unit per favorable
rounding" to "one 18-decimal share wei per favorable rounding." That is the intended
economic mitigation.

## Tests

Command used:

```bash
source ~/.nvm/nvm.sh && nvm use 18.20.8 && . ./setup-test-env.sh && TS_NODE_TRANSPILE_ONLY=1 npx hardhat test test-suites/__setup.spec.ts test-suites/wrapper-listing.spec.ts
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

- Wrapper conversion and fixed-rate redemption:
  - 18-decimal shares.
  - 6-decimal raw asset maps `1` raw unit to `1e12` share wei.
  - `previewRedeem(1) == 0`.
  - `redeem(1)` reverts because wrapper dust is not a whole raw-asset unit.
  - Direct underlying transfers do not change the fixed conversion rate.
- Pool reserve listing:
  - Wrapper can be initialized as a reserve through the existing configurator.
  - Raw low-decimal asset is not listed.
  - Supplying wrapper shares to the Pool and withdrawing one wrapper share wei works.
  - Redeeming that one wrapper share wei reverts.
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

Oracle design is simple with the fixed-rate wrapper.
The wrapper conversion rate is static: one whole wrapper token claims one whole
underlying token. A static 1:1 decimal-normalized wrapper price is therefore
consistent with the wrapper accounting, assuming the underlying itself is priced
correctly.

Direct transfers of underlying into the wrapper create surplus underlying, but they
do not increase the redemption value of wrapper shares. That avoids share-price
drift, but it also means accidental donations are stuck unless a future version adds
an explicitly governed surplus-recovery path.

Underlying token assumptions matter. The wrapper assumes a standard, non-rebasing,
non-fee-on-transfer ERC-20. Fee-on-transfer assets can make the wrapper over-mint.
Rebasing or balance-mutating assets can break the fixed 1:1 backing assumption.

Stable borrowing remains a separate review item. The tests intentionally cover
variable debt. If stable borrowing is enabled for a wrapper reserve, stable debt
rounding and accrual should be reviewed separately.

Dust UX needs care. Wrapper dust below one raw-asset unit cannot be redeemed. This
is intentional for the rounding mitigation, but frontends and integrations should
avoid presenting non-redeemable dust as useful withdrawable value.

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
