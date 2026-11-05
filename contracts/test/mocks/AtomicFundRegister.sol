// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAgenticCommerce} from "../../interfaces/IAgenticCommerce.sol";
import {ISQController} from "../../interfaces/ISQController.sol";

interface IKernelFund {
    function fund(uint256 jobId, bytes calldata optParams) external;
    function createJob(address provider, address evaluator, uint256 expiredAt, string calldata description, address hook)
        external
        returns (uint256);
}

/// @notice Test-only job client that funds the kernel job and registers it with SQController in ONE
///         transaction. Models Arc's Multicall3From style batching: because both calls execute in a
///         single transaction, the provider has no opportunity to submit between fund and register.
contract AtomicFundRegister {
    IKernelFund public immutable kernel;
    ISQController public immutable sq;
    IERC20 public immutable usdc;

    constructor(address kernel_, address sq_, address usdc_) {
        kernel = IKernelFund(kernel_);
        sq = ISQController(sq_);
        usdc = IERC20(usdc_);
    }

    /// @dev This contract becomes the job client (and therefore the SQController buyer).
    function createJob(address provider, uint256 expiredAt) external returns (uint256) {
        return kernel.createJob(provider, address(sq), expiredAt, "SQ job", address(0));
    }

    /// @dev Requires the provider to have set the budget and this contract to hold budget + deposit USDC.
    function fundAndRegister(ISQController.RegisterParams calldata p) external {
        uint256 budget = IAgenticCommerce(address(kernel)).getJob(p.jobId).budget;
        uint256 deposit = p.feePerReport * p.committee.length * (uint256(p.revisionLimit) + 1);
        usdc.approve(address(kernel), budget);
        usdc.approve(address(sq), deposit);
        kernel.fund(p.jobId, "");
        sq.registerJob(p);
    }
}
