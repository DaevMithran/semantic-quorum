// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ITokenReceiverHook} from "./MockUSDC.sol";

/// @notice Test-only recipient that tries to re-enter a target when it receives tokens.
contract MaliciousRecipient is ITokenReceiverHook {
    address public target;
    bytes public attackData;
    bool public attacked;
    bool public attackSucceeded;

    function arm(address target_, bytes calldata data) external {
        target = target_;
        attackData = data;
        attacked = false;
        attackSucceeded = false;
    }

    function onTokenReceived() external override {
        if (target == address(0) || attacked) return;
        attacked = true;
        (bool ok,) = target.call(attackData);
        attackSucceeded = ok;
    }

    function callTarget(address target_, bytes calldata data) external returns (bool ok, bytes memory ret) {
        (ok, ret) = target_.call(data);
    }
}
