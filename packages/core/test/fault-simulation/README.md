# Wallet fault simulation

Test-only harness for the [wallet fault simulation design](../../../../docs/design/wallet-fault-simulation.md)
([spec #616](https://github.com/cashubtc/coco/issues/616)). Coco owns the workload and pass/fail
requirements ([ADR-0018](../../docs/adr/0018-keep-wallet-simulation-correctness-owned-by-coco.md)).

## Run

From the repository root, with Docker, Node.js 22 or newer and Git available:

```bash
bun run test:fault-simulation                      # all scenarios
bun run test:fault-simulation -t 'healthy baseline' # one scenario
bun packages/core/test/fault-simulation/replay.ts .cache/fault-simulation/runs/<run>/trace.json
```

The script builds core first because the SQLite repositories import its build output. The scenario
file is named `*.sim.ts` so plain `bun test` and the unit and integration runners do not select it.

The first run fetches the pinned Cashu Fault Lab revision into `.cache/`. Set
`COCO_FAULT_LAB_CHECKOUT` to use an existing checkout; it must be at the pinned revision.

## World

Each scenario run starts its own world and removes it afterwards:

- one `cashubtc/mintd:0.17.0-rc.0` container with the `fakewallet` backend, unit `sat` and
  100 ppk input fees, matching `scripts/test-integration.sh`;
- one pinned Fault Lab HTTP gateway process in front of that mint, run under Node;
- one process per Wallet, each a real Coco Session over its own SQLite file and Wallet Seed, with
  Coco's default Background Watchers and Processors.

Wallets only know the gateway URL, so all their mint HTTP traffic passes through it. The harness
probes the mint directly and opens Wallet stores read-only. It never repairs Wallet state.

A crash is `SIGKILL` of a Wallet process. A restart is a new process and a new Coco Session over the
same store and Wallet Seed.

## Outcomes and evidence

`accounting.ts` checks value independently of Coco's displayed balances: proof states come from the
mint, token contents from the harness's own decoding, and fees from the mint's keyset input fee rate.
Displayed balances, operation states and history are corroborated against that ledger.

Runs end as `pass`, `wallet_failure`, `unresolved` (missing evidence or an unestablished scenario
precondition, such as a fault that never fired) or `infrastructure_failure`. Only `pass` passes,
except that negative controls expect `wallet_failure`.

Artifacts are written under `.cache/fault-simulation/runs/<run>/` (override with
`COCO_FAULT_SIM_ARTIFACTS`):

- `trace.json`: portable, redacted plan, component versions, configuration, ordered events, fault
  evidence and verdict. Tokens appear as references. Writing fails if any registered Wallet Seed,
  token or proof secret would appear in it.
- `private/`: Wallet Seeds, SQLite stores and Wallet process logs. It is removed when a run meets its
  expectation and kept otherwise, or always with `COCO_FAULT_SIM_KEEP_PRIVATE=1`. Never publish it.

Replay reruns the recorded plan from clean state with fresh Wallet Seeds. It reproduces the
scenario's commands and request-triggered faults, not operating-system scheduling.

## Modules

| Module                  | Responsibility                                                 |
| ----------------------- | -------------------------------------------------------------- |
| `scenarios.ts`          | Scenario plans as replayable data                              |
| `runner.ts`             | World lifecycle, step execution, evidence collection, outcomes |
| `walletActor.ts`        | Harness handle for a Wallet process: commands, crash, shutdown |
| `walletActorProcess.ts` | The Wallet process: one Coco Session over SQLite               |
| `faultLabGateway.ts`    | Thin adapter over the pinned Fault Lab HTTP gateway            |
| `environment.ts`        | Mint containers and infrastructure failure classification      |
| `evidence.ts`           | Read-only store queries, direct mint probes and token decoding |
| `accounting.ts`         | Independent fund accounting checker                            |
| `trace.ts`              | Redacted trace                                                 |

A run killed with `SIGKILL` can leave a mint container behind; `docker ps --filter name=coco-faultsim-`
lists them.
