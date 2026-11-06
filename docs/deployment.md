# Arc testnet deployment

The canonical deployed addresses and constructor data are recorded in
[`deployments/arc-testnet.json`](../deployments/arc-testnet.json).

## Prerequisites

- Foundry installed
- An encrypted Foundry keystore
- Arc testnet USDC for gas from the [Circle faucet](https://faucet.circle.com)

Install Foundry and import the deployment wallet if needed:

```bash
curl -L https://foundry.paradigm.xyz | bash && foundryup
cast wallet import sq-deployer --interactive
```

Never pass a private key directly as a command-line argument.

## Deploy SQController

```bash
make deploy
```

`contracts/script/DeploySQController.s.sol` deploys against:

- Arc testnet, chain ID `5042002`
- `AgenticCommerce`: `0x0747EEf0706327138c69792bF28Cd525089e4583`
- USDC: `0x3600000000000000000000000000000000000000`
- CRE simulation forwarder: `0x6E9EE680ef59ef64Aa8C7371279c27E496b5eDc1`
- CRE production forwarder: `0x76c9cf548b4179F8901cda1f8623568b58215E62`

The script refuses to run on any chain other than Arc testnet.

## Configure services after deployment

Put the deployed `SQController` address in:

- `cre/src/workflows/sq-verdict/config.arc.json` as `sqController`
- `services/coordinator/.env` as `SQ_CONTROLLER_ADDRESS`

Then run the Arc stack and create a test job using the commands in
[Development and testing](development.md).
