// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title Deployed Arc AgenticCommerce kernel interface
/// @notice Minimal ABI for the existing kernel; getJob deliberately has no deliverable field.
interface IAgenticCommerce {
    enum JobStatus { Open, Funded, Submitted, Completed, Rejected, Expired }

    struct Job {
        uint256 id;
        address client;
        address provider;
        address evaluator;
        string description;
        uint256 budget;
        uint256 expiredAt;
        JobStatus status;
        address hook;
    }

    /// @notice Returns the kernel's nine-field job record.
    function getJob(uint256 jobId) external view returns (Job memory);

    /// @notice Returns the admin-controlled platform fee in basis points, reducing the provider's net.
    function platformFeeBP() external view returns (uint256);

    /// @notice Returns the admin-controlled evaluator fee in basis points, paid to the evaluator.
    function evaluatorFeeBP() external view returns (uint256);

    /// @notice Completes a submitted job as its designated evaluator.
    function complete(uint256 jobId, bytes32 reason, bytes calldata optParams) external;

    /// @notice Rejects a funded or submitted job as its designated evaluator.
    function reject(uint256 jobId, bytes32 reason, bytes calldata optParams) external;
}
