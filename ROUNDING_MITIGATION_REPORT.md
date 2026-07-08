# Rounding Mitigation Report

## Scope

This repository is a SparkLend fork of older Aave V3 code. The goal is to mitigate the high-value, low-decimal asset rounding issue addressed in Aave v3.5 without importing the whole Aave 3.1-3.7 upgrade history.

This report focuses on the scaled accounting boundary used by aTokens and variable debt tokens:

- unscaled asset amount -> scaled balance: `amount / index`
- scaled balance -> unscaled balance: `scaledBalance * index`
- base-currency valuation: `amount * price / assetUnit`

## Problem Summary

The current fork uses half-up rounding for wad/ray math. In `WadRayMath`, `rayMul` adds `HALF_RAY` before dividing, and `rayDiv` adds `b / 2` before dividing. This means a conversion can round either in favor of the user or in favor of the protocol depending on the reserve index at that moment.

For ordinary 18-decimal assets, a one-wei rounding leak is economically negligible. For high-value, low-decimal assets such as XAUT or WBTC-like assets, one smallest unit has meaningful value. Repeating supply, withdraw, borrow, repay, transfer, or liquidation paths can turn a one-unit directional error into an extractable loop if the rounding sometimes favors the user.

Aave v3.5 did not globally replace half-up math. It added explicit floor/ceil variants and applied them at the token/accounting boundaries so the protocol gets pessimistic rounding:

- aToken mint/supply: round scaled amount down.
- aToken burn/withdraw: round scaled amount up.
- aToken balance/totalSupply: round unscaled balance down.
- aToken transfer scaled amount: round up.
- variable debt mint/borrow: round scaled debt up.
- variable debt burn/repay/liquidation: round scaled debt down.
- variable debt balance/totalSupply: round unscaled debt up.
- collateral valuation: round down.
- debt valuation: round up.

## Local Code Map

Important local files and current behavior:

- `contracts/protocol/libraries/math/WadRayMath.sol`
  - Lines 10, 65-72, and 83-90 show the current half-up behavior.
- `contracts/protocol/tokenization/base/ScaledBalanceTokenBase.sol`
  - `_mintScaled` uses `amount.rayDiv(index)` at line 72.
  - `_burnScaled` uses `amount.rayDiv(index)` at line 100.
  - `_transfer` uses `amount.rayDiv(index)` at line 142.
- `contracts/protocol/tokenization/AToken.sol`
  - `balanceOf` and `totalSupply` use half-up `rayMul` at lines 131 and 142.
  - `transfer` snapshots and emits scaled amounts using half-up math at lines 208-217.
- `contracts/protocol/tokenization/VariableDebtToken.sol`
  - `balanceOf` and `totalSupply` use half-up `rayMul` at lines 87 and 115.
  - `mint` and `burn` still pass unscaled amounts into shared `_mintScaled` / `_burnScaled`.
- `contracts/protocol/libraries/logic/SupplyLogic.sol`
  - Supply passes unscaled `params.amount` into `IAToken.mint`.
  - Withdraw computes user balance with half-up `rayMul`, then burns by unscaled amount.
  - `executeFinalizeTransfer` still reasons in unscaled `amount` and unscaled before-balances.
- `contracts/protocol/libraries/logic/BorrowLogic.sol`
  - Variable debt borrow passes unscaled `params.amount` into `IVariableDebtToken.mint`.
  - Variable debt repay burns by unscaled `paybackAmount`.
- `contracts/protocol/libraries/logic/GenericLogic.sol`
  - Variable debt base-currency valuation uses half-up debt balance and floors the price conversion.
  - Collateral valuation uses half-up aToken balance and floors the price conversion.
- `contracts/protocol/libraries/logic/LiquidationLogic.sol`
  - Liquidation protocol fee scaling uses half-up `rayDiv`.
  - `_calculateAvailableCollateralToLiquidate` uses half-up percentage division in the `userCollateralBalance` constrained branch.
- `contracts/protocol/tokenization/StableDebtToken.sol`
  - This fork still has stable debt. Aave v3.5 origin code is much more variable-debt-centric, so stable debt needs a separate review if stable borrowing is enabled.
- `hardhat.config.ts`
  - The repo compiles with Solidity `0.8.10` and `evmVersion: london`, so transient storage is not available without a compiler/EVM-target upgrade.

## Resources For Future Agents

- Aave v3.5 feature document: `https://github.com/aave-dao/aave-v3-origin/blob/main/docs/3.5/Aave-v3.5-features.md`
- Aave v3.5 tag used for comparison: `https://github.com/aave-dao/aave-v3-origin/tree/v3.5.0`
- Aave v3.4 tag for pre-change comparison: `https://github.com/aave-dao/aave-v3-origin/tree/v3.4.0`
- Aave v3.5 `TokenMath`: `src/contracts/protocol/libraries/helpers/TokenMath.sol`
- Aave v3.5 `WadRayMath`: `src/contracts/protocol/libraries/math/WadRayMath.sol`
- Aave v3.5 token files: `AToken.sol`, `VariableDebtToken.sol`, `ScaledBalanceTokenBase.sol`, `IncentivizedERC20.sol`
- Aave v3.5 logic files: `SupplyLogic.sol`, `BorrowLogic.sol`, `ValidationLogic.sol`, `GenericLogic.sol`, `ReserveLogic.sol`, `LiquidationLogic.sol`
- Local Certora comments already model the old `+0.5` slack: `certora/specs/AToken.spec` and `certora/specs/VariableDebtToken.spec`

## Approach 1: Minimal Token-Boundary Backport

Patch only the scaled aToken and variable debt token accounting boundary, while keeping the public Pool, `IAToken`, and `IVariableDebtToken` interfaces unchanged.

Implementation outline:

- Add `rayMulFloor`, `rayMulCeil`, `rayDivFloor`, and `rayDivCeil` to local `WadRayMath`.
- Add a small local `TokenMath` helper matching Aave v3.5's direction choices.
- Refactor `ScaledBalanceTokenBase` with internal functions that accept a precomputed scaled amount and a balance conversion function. Keep existing external token APIs unscaled.
- In `AToken`:
  - `mint`: compute scaled amount with floor division.
  - `burn`: compute scaled amount with ceil division.
  - `balanceOf` / `totalSupply`: use floor multiplication.
  - transfers and liquidation transfers: compute scaled amount with ceil division and emit `BalanceTransfer` with the actual scaled amount.
- In `VariableDebtToken`:
  - `mint`: compute scaled amount with ceil division.
  - `burn`: compute scaled amount with floor division.
  - `balanceOf` / `totalSupply`: use ceil multiplication.
- In `LiquidationLogic`, update the liquidation protocol fee pre-check to use the same ceil-scaled transfer amount that `AToken.transferOnLiquidation` will burn, otherwise the half-up pre-check can pass while the ceil transfer reverts by one scaled unit.
- Optionally use the v3.5-style event calculation in `_mintScaled` / `_burnScaled` so `Mint` and `Burn` event values match actual balance deltas.

Why this is attractive:

- It targets the direct loop surface: supply, withdraw, aToken transfer, borrow, repay, and variable debt balance reads.
- It avoids changing Pool ABI and avoids changing token interfaces used by the rest of the fork.
- It leaves interest-rate math, index accrual, flash-loan premium math, bridge fee math, and most validation logic untouched.

Risks and second-order effects:

- Allowances remain slightly imprecise unless `transferFrom` and delegated borrow allowance are also updated. The protocol is protected, but a spender/delegatee may consume an allowance that differs by one unit from the actual balance/debt change.
- `SupplyLogic.executeFinalizeTransfer` still receives unscaled before-balances and amount. It should continue to work for full-balance transfer cases if `balanceOf` floors, but this is less exact than v3.5's scaled transfer finalization.
- Stable debt is not covered. If stable-rate borrowing is enabled for high-value, low-decimal assets, it needs separate pessimistic rounding review.
- Existing tests that assert exact half-up event values will need updates.

Recommended verification:

- Property: for all `amount,index`, aToken mint credits an unscaled balance `<= amount`.
- Property: withdraw of `amount` burns shares whose unscaled value is `>= amount`, and `withdraw(aToken.balanceOf(user))` clears scaled balance.
- Property: variable debt borrow records debt `>= amount`.
- Property: repay of `vDebt.balanceOf(user)` clears scaled debt.
- Property: aToken transfer of `balanceOf(user)` clears sender scaled balance and recipient receives at least requested amount.
- Regression tests around liquidation protocol fee transfer when fee is exactly at the last wei of user collateral.

## Approach 2: v3.5-Style Scaled Accounting Backport

Backport the full v3.5 rounding design, but adapt it to this older Spark/Aave V3 fork instead of copying later files wholesale.

Implementation outline:

- Add floor/ceil math and `TokenMath`.
- Change `IAToken.mint`, `IAToken.burn`, `IAToken.mintToTreasury`, and `IAToken.transferOnLiquidation` to accept scaled amounts where v3.5 does.
- Change `IVariableDebtToken.mint` and `IVariableDebtToken.burn` to accept scaled amounts.
- Change `Pool.finalizeTransfer` and `DataTypes.FinalizeTransferParams` to pass scaled amount and scaled pre-transfer balances.
- Compute scaled amounts once in `SupplyLogic`, `BorrowLogic`, and `LiquidationLogic`, then pass those scaled amounts through token calls and validations.
- Update `ValidationLogic` cap checks to use scaled supply plus the scaled operation amount before converting to unscaled with floor aToken balance math.
- Update `GenericLogic` so collateral valuation rounds down and debt valuation rounds up in base currency.
- Update liquidation math so debt-needed paths and leftover-debt checks round against the user.
- Update treasury accrual to avoid scale-up then scale-down precision loss where practical.
- Port the allowance improvements for `AToken.transferFrom` and delegated variable debt mint.

Why this is attractive:

- This is the most semantically aligned with Aave v3.5.
- It closes not only the direct loop but also secondary imprecision in caps, health factor valuation, transfer finalization, treasury accrual, events, and allowances.
- It gives future auditors an upstream reference for most design choices.

Risks and second-order effects:

- This is no longer a tiny patch. It touches token interfaces, Pool finalization, DataTypes, logic libraries, tests, and any integrations compiled against the old interfaces.
- Directly copying v3.5 files is unsafe because this fork still has older features such as stable debt and different storage/API assumptions.
- More behavior changes mean more tests and formal spec updates.

Recommended verification:

- Everything from Approach 1.
- Supply cap and borrow cap tests at exact rounding boundaries.
- Health factor tests where one wei of debt would previously round to zero in base currency.
- Liquidation tests where collateral is exhausted and `debtAmountNeeded` must round up.
- Transfer finalization tests using scaled balances, including collateral flag clearing.
- Storage layout checks for all upgradeable token implementations.

## Approach 3: Rounding Direction Flag

Add a short-lived rounding mode flag that is set by the token entry point before shared mint/burn/transfer accounting runs. The shared code then reads the flag, uses floor or ceil division, and resets the flag to inactive.

The flag should be an enum, not a boolean, because there are three states:

- `INACTIVE`: no rounding context has been set; fail closed.
- `ROUND_DOWN`: use floor division.
- `ROUND_UP`: use ceil division.

The intended mapping would be:

- aToken mint paths: `ROUND_DOWN`.
- aToken burn paths: `ROUND_UP`.
- aToken transfer paths, including liquidation transfer: `ROUND_UP`.
- variable debt mint paths: `ROUND_UP`.
- variable debt burn paths: `ROUND_DOWN`.

Balance reads still need hardcoded direction choices: aToken `balanceOf` and `totalSupply` should round down, and variable debt `balanceOf` and `totalSupply` should round up. The flag only helps with operation-specific scaled division.

Implementation variants:

- Persistent storage flag in token contracts.
  - `AToken.mint`, `AToken.burn`, `AToken._transfer`, `AToken.mintToTreasury`, and `AToken.transferOnLiquidation` set the flag before calling shared internal logic.
  - `VariableDebtToken.mint` and `VariableDebtToken.burn` do the same with the opposite directions.
  - The shared function consumes the flag and resets it before any external call such as incentives hooks or Pool finalization.
- Transient storage flag.
  - This avoids persistent storage layout and most storage gas, but it is not available with the current Solidity `0.8.10` and London target. Adopting it means a compiler/EVM-target migration, which is much larger than a rounding patch.
- Internal enum parameter instead of storage.
  - This keeps the same conceptual design but passes the rounding mode explicitly to `_mintScaled`, `_burnScaled`, and transfer helpers. At that point it becomes essentially Approach 1 with an enum instead of separate helper functions.

Why this is attractive:

- It can keep the public Pool/token ABI unchanged if the flag is set inside existing token entry points.
- It centralizes fail-closed behavior: a shared conversion can revert if no active rounding context exists.
- It avoids duplicating separate `_mintScaledUp`, `_mintScaledDown`, `_burnScaledUp`, and `_burnScaledDown` helpers.
- It is conceptually easy to map each high-level operation to the correct rounding direction.

Reasons against it:

- With persistent storage, each mint/burn/transfer needs at least one set-and-clear cycle. Under the current London target, this is meaningfully more expensive than passing a memory argument or calling a pure helper.
- Adding storage to `ScaledBalanceTokenBase` is dangerous for upgradeable tokens because that base currently has no storage variables; inserting one there can shift child storage such as `AToken._treasury` and `_underlyingAsset`. Adding storage only at leaf contracts is safer, but then the base needs hooks or duplicated logic to read it.
- The flag is hidden mutable context for what is naturally a pure arithmetic choice. That makes the code harder to audit and easier to misuse than explicit `rayDivFloor` / `rayDivCeil` calls.
- Every relevant entry point must set the right flag. Missing a path causes a revert; setting the wrong flag reintroduces the rounding bug or overcharges users.
- The flag must be consumed and reset before any external call. `_mint` / `_burn` can call the incentives controller, and aToken transfers call back into `Pool.finalizeTransfer`; leaving a flag active across those boundaries is unnecessary reentrancy-shaped complexity.
- It only addresses scaled division paths. The implementation still needs separate changes for aToken/vToken balance rounding, health-factor valuation, liquidation fee scaling, and possibly cap checks.
- Formal verification becomes more stateful. Specs would need invariants proving the flag is inactive at public function boundaries and that each path sets the correct direction.

Risks and second-order effects:

- Storage-layout risk is the biggest blocker for a persistent flag. If this path is chosen, do not add the flag to `ScaledBalanceTokenBase` without a storage layout analysis.
- Gas cost can be material for common operations. The protocol would pay extra state-write overhead in exactly the hot paths users call most.
- A storage flag couples operation context to shared accounting. Future token extensions could accidentally reuse `_mintScaled`, `_burnScaled`, or transfer helpers without setting the context.
- Transient storage avoids some of these risks, but it introduces deployment-target and toolchain risk instead.
- The inactive-state revert is useful as a guard, but it can also create accidental DoS if a rarely used path such as bridge minting, treasury minting, stable/variable swap, or liquidation transfer is missed.

Recommended verification:

- Assert the flag is inactive at the end of every public/external token function, including reverting test harnesses where possible.
- Exhaustively test every caller of `IAToken.mint`, `IAToken.burn`, `IAToken.mintToTreasury`, `IAToken.transferOnLiquidation`, `IVariableDebtToken.mint`, and `IVariableDebtToken.burn`.
- Test bridge minting, treasury minting, `repayWithATokens`, liquidation burn, liquidation aToken transfer, and stable/variable rate swaps because these are easy paths to miss.
- Run storage layout checks before and after the change.
- Add the same economic rounding properties listed in Approach 1.

Assessment:

This approach is not worth implementing as a persistent storage flag in the current fork. It buys little over an explicit enum/internal-helper implementation, while adding gas, storage-layout, hidden-state, and auditability risk. If the team likes the fail-closed idea, prefer an internal enum parameter passed through shared functions. If a future unrelated upgrade already moves the codebase to a Cancun-capable compiler and EVM target, a transient-storage version could be reconsidered, but it should still be compared against the simpler explicit-helper design.

## Alternative Idea: Wrapper Listing

For markets that intend to support high-value, low-decimal assets, list an 18-decimal wrapper with ERC-4626-style pessimistic rounding instead of listing the raw asset directly.

Implementation outline:

- For XAUT/WBTC-like assets, list a wrapper token with 18 decimals and conservative deposit/redeem rounding.
- Keep the underlying asset outside core reserve accounting; users interact with the wrapper reserve.
- If an affected asset is already listed directly, freeze/disable the risky side, migrate liquidity to the wrapper market, then unlist or keep the direct reserve non-collateral/non-borrowable.

Why this is attractive:

- It can require no core Pool/token changes.
- It reduces the economic value of a one-share rounding unit back to negligible levels.
- It is a good emergency or phased mitigation if protocol upgrades are slow.

Risks and second-order effects:

- It does not fix the core bug. Any directly listed high-value, low-decimal asset remains exposed.
- It adds wrapper contract risk, oracle/listing complexity, liquidity migration work, and integration friction.
- The wrapper itself must be audited for pessimistic rounding. A sloppy wrapper can simply move the rounding issue one layer outward.

Recommended verification:

- Wrapper deposit mints shares rounded down.
- Wrapper redeem/withdraw burns shares rounded up.
- One wrapper share wei is economically negligible relative to gas and oracle precision.
- Core reserves never list the raw high-value, low-decimal asset as active collateral or borrowable debt.

## Recommendation

The best least-change core mitigation is Approach 1, with two additions from the v3.5 design: exact event delta calculation and the liquidation fee transfer pre-check using ceil-scaled aToken transfer math. This should neutralize the supply/withdraw/borrow/repay dust loop without importing unrelated Aave upgrades.

Approach 2 is the cleanest long-term accounting model, but it is a broader protocol upgrade and should be treated as such. Approach 3 is an interesting mechanism, but it should not be implemented as persistent storage in this fork; use an explicit internal parameter if this shape is preferred.

Wrapper listing is useful as an asset-onboarding control, especially if the team intends to list high-value, low-decimal assets, but it should be treated as an alternative listing strategy rather than a core protocol rounding fix.

Avoid a global change to `rayMul` or `rayDiv`. The correct direction depends on context: aToken mint wants floor division, aToken burn wants ceil division, variable debt mint wants ceil division, and variable debt burn wants floor division. A single global direction will make at least one important path less safe.
