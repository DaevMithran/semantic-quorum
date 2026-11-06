// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SQController} from "../SQController.sol";
import {IAgenticCommerce} from "../interfaces/IAgenticCommerce.sol";

/// @notice Deploys SQController on Arc testnet against Arc's deployed ERC-8183 kernel.
/// @dev Run (key from an encrypted Foundry keystore, never a plain-text flag):
///   cast wallet import sq-deployer --interactive
///   forge script contracts/script/DeploySQController.s.sol:DeploySQController \
///     --rpc-url arc_testnet --account sq-deployer --broadcast
/// Addresses can be overridden with env vars of the same name.
contract DeploySQController is Script {
    uint256 internal constant ARC_TESTNET = 5042002;

    // Arc testnet: ERC-8183 reference kernel and the USDC ERC-20 interface (6 decimals).
    address internal constant AGENTIC_COMMERCE = 0x0747EEf0706327138c69792bF28Cd525089e4583;
    address internal constant USDC = 0x3600000000000000000000000000000000000000;
    // Chainlink CRE forwarders for arc-testnet (docs.chain.link CRE forwarder directory).
    address internal constant SIM_FORWARDER = 0x6E9EE680ef59ef64Aa8C7371279c27E496b5eDc1;
    address internal constant PROD_FORWARDER = 0x76c9cf548b4179F8901cda1f8623568b58215E62;

    function run() external returns (SQController sq) {
        // Guard against deploying to the wrong network; ALLOW_ANY_CHAIN=true is for local dry runs only.
        if (!vm.envOr("ALLOW_ANY_CHAIN", false)) {
            require(block.chainid == ARC_TESTNET, "DeploySQController: not Arc testnet (5042002)");
        }
        address kernel = vm.envOr("AGENTIC_COMMERCE", AGENTIC_COMMERCE);
        address usdc = vm.envOr("USDC", USDC);
        address simFwd = vm.envOr("SIM_FORWARDER", SIM_FORWARDER);
        address prodFwd = vm.envOr("PROD_FORWARDER", PROD_FORWARDER);

        vm.startBroadcast();
        sq = new SQController(IAgenticCommerce(kernel), IERC20(usdc), simFwd, prodFwd);
        vm.stopBroadcast();

        console2.log("SQController   ", address(sq));
        console2.log("AgenticCommerce", kernel);
        console2.log("USDC           ", usdc);
        console2.log("SIM_FORWARDER  ", simFwd);
        console2.log("PROD_FORWARDER ", prodFwd);
    }
}
