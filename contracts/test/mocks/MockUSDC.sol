// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface ITokenReceiverHook {
    function onTokenReceived() external;
}

/// @notice Test-only 6-decimal USDC stand-in. Mimics two Arc behaviors that matter to SQController:
///         transfers to or from a blocklisted address revert, and transfers to address(0) revert.
///         Optionally calls a receive hook on contract recipients so reentrancy can be exercised.
contract MockUSDC is ERC20 {
    mapping(address => bool) public blocklisted;
    bool public receiveHookEnabled;

    error Blocklisted(address account);

    constructor() ERC20("Mock USDC", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setBlocklisted(address account, bool status) external {
        blocklisted[account] = status;
    }

    function setReceiveHook(bool enabled) external {
        receiveHookEnabled = enabled;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (blocklisted[from]) revert Blocklisted(from);
        if (blocklisted[to]) revert Blocklisted(to);
        super._update(from, to, value);
        if (receiveHookEnabled && to.code.length > 0 && from != address(0)) {
            ITokenReceiverHook(to).onTokenReceived();
        }
    }
}
