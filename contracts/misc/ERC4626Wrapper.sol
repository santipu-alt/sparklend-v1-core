// SPDX-License-Identifier: MIT
pragma solidity ^0.8.10;

import {ERC20} from '@openzeppelin/contracts/token/ERC20/ERC20.sol';
import {ERC4626} from '@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol';
import {IERC20Metadata} from '@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol';

/**
 * @title ERC4626Wrapper
 * @notice OpenZeppelin ERC4626 wrapper that exposes 18-decimal shares for a lower-decimal asset.
 */
contract ERC4626Wrapper is ERC4626 {
  uint8 private immutable _assetDecimals;
  uint8 private immutable _shareDecimalsOffset;

  constructor(
    IERC20Metadata asset_,
    string memory name_,
    string memory symbol_
  ) ERC20(name_, symbol_) ERC4626(asset_) {
    uint8 assetDecimals_ = asset_.decimals();
    require(assetDecimals_ <= 18, 'WRAPPER_DECIMALS_GT_18');

    _assetDecimals = assetDecimals_;
    _shareDecimalsOffset = 18 - assetDecimals_;
  }

  function assetDecimals() external view returns (uint8) {
    return _assetDecimals;
  }

  function shareScale() external view returns (uint256) {
    return 10 ** _shareDecimalsOffset;
  }

  function _decimalsOffset() internal view override returns (uint8) {
    return _shareDecimalsOffset;
  }
}
