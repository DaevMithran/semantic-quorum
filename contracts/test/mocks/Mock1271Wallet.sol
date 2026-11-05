// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @notice Test-only ERC-1271 wallet: a signature is valid iff it is an ECDSA signature over the
///         exact digest produced by the wallet's owner key.
contract Mock1271Wallet {
    bytes4 internal constant MAGIC = 0x1626ba7e;

    address public immutable owner;

    constructor(address owner_) {
        owner = owner_;
    }

    function isValidSignature(bytes32 digest, bytes calldata signature) external view returns (bytes4) {
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(digest, signature);
        if (err == ECDSA.RecoverError.NoError && recovered == owner) return MAGIC;
        return 0xffffffff;
    }
}
