# Cashu Fault Lab integration

This optional integration runs Coco against the experimental
[`cashu-fault-lab`](https://github.com/GautamBytes/cashu-fault-lab) wallet lifecycle suite. It is
test tooling, not a runtime dependency or release certification gate.

The first lane covers `mint-response-lost`: mintd commits a NUT-04 issuance, the official Fault Lab
gateway drops that response, and Coco must converge on one successful operation with the original
output plan and a 64 sat wallet credit.

## Run

Prerequisites:

- Bun and the repository dependencies (`bun install --frozen-lockfile`)
- Node.js 24 (required by `cashu-fault-lab@0.2.0`)
- Docker with Compose

```bash
bun run test:fault-lab:mint-response-lost
```

The script starts pinned mintd and Fault Lab containers, launches the test-only Coco lifecycle
adapter on `127.0.0.1:4103`, runs the published Fault Lab CLI, and removes its containers and
temporary SQLite database afterward. Set `COCO_FAULT_LAB_REPORT` to retain the redacted JSON report:

```bash
COCO_FAULT_LAB_REPORT=artifacts/fault-lab/mint-response-lost.json \
  bun run test:fault-lab:mint-response-lost
```

The adapter currently advertises only `mint` and process durability. Restart scenarios require a
generic external-adapter restart hook in Fault Lab or a Coco-specific driver.
