// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ISQController} from "../interfaces/ISQController.sol";

/// @title Semantic Quorum EIP-712 struct hashing
/// @notice Domain separation is applied by SQController, not by this library.
library SQVerdict {
    bytes32 internal constant VERDICT_TYPEHASH = keccak256(
        "Verdict(uint256 jobId,uint8 round,uint8 kind,bytes32 deliverable,bytes32 evidenceHash,bytes32 reportsHash,bytes32 deficiencyHash,uint256 includedMask,bytes32 policyHash,bytes32 participantSnapshotHash)"
    );

    /// @notice Hashes a verdict with the policy and participant commitments loaded by the controller.
    /// @dev The enum is encoded as uint8; the commitments must come from registered storage.
    function hash(
        ISQController.Verdict memory v,
        bytes32 policyHash,
        bytes32 participantSnapshotHash
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(
            VERDICT_TYPEHASH,
            v.jobId,
            v.round,
            uint8(v.kind),
            v.deliverable,
            v.evidenceHash,
            v.reportsHash,
            v.deficiencyHash,
            v.includedMask,
            policyHash,
            participantSnapshotHash
        ));
    }
}
