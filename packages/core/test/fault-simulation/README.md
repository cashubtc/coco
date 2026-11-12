# Wallet fault simulation

Test-only harness for the [wallet fault simulation design](../../../../docs/design/wallet-fault-simulation.md)
([spec #616](https://github.com/cashubtc/coco/issues/616)). Coco owns the workload and pass/fail
requirements ([ADR-0018](../../docs/adr/0018-keep-wallet-simulation-correctness-owned-by-coco.md)).

## Run

From the repository root, with Docker, Node.js 22 or newer and Git available:

```bash
bun run test:fault-simulation                        # all scenarios
bun run test:fault-simulation -t 'healthy workload'  # one scenario
COCO_FAULT_SIM_SEEDS=11,12 bun run test:fault-simulation -t 'generated workload'
COCO_FAULT_SIM_FAULT_SEEDS=7 bun run test:fault-simulation -t 'fault interactions'
bun packages/core/test/fault-simulation/replay.ts .cache/fault-simulation/runs/<run>/trace.json
bun packages/core/test/fault-simulation/minimize.ts .cache/fault-simulation/runs/<run>/trace.json 24
bun packages/core/test/fault-simulation/report.ts .cache/fault-simulation/runs/*/trace.json
bun packages/core/test/fault-simulation/artifacts.ts .cache/fault-simulation/runs/<run> <outDir>
bun test ./packages/core/test/fault-simulation/walletFaultSimulationArtifacts.sim.ts  # after building core
```

The script builds core first because the SQLite repositories import its build output. The scenario
file is named `*.sim.ts` so plain `bun test` and the unit and integration runners do not select it.
`COCO_FAULT_SIM_SEEDS` takes comma-separated scenario seeds (unsigned 32-bit integers) for the
fault-free generated workloads, default `1,2`; `COCO_FAULT_SIM_FAULT_SEEDS` does the same for
generated workloads with fault interactions (`faultPalette.sim.ts`), default `5,18`, each run in
both recovery modes.

The first run fetches the pinned Cashu Fault Lab revision into `.cache/`. Set
`COCO_FAULT_LAB_CHECKOUT` to use an existing checkout; it must be at the pinned revision.

## World

Each scenario run starts its own world and removes it afterwards:

- one `cashubtc/mintd:0.17.0-rc.0` container per logical mint (`mint-a`, `mint-b`), each with the
  `fakewallet` backend, unit `sat`, 100 ppk input fees and its own test mnemonic, so the two mints
  have distinct keysets;
- one pinned Fault Lab HTTP gateway process in front of each mint, run under Node;
- one transport link process (`transportLinkProcess.ts`, under Node), the only network path between
  Wallets and mints;
- one process per Wallet (`alice`, `bob`, `carol` in the multi-Wallet scenarios), each a real Coco
  Session over its own SQLite file and Wallet Seed, trusting every mint, with Coco's default
  Background Watchers and Processors.

Every Wallet uses the same canonical URL per mint, `http://<mint>.faultsim.invalid`, which never
resolves, and its own transport link port as proxy: HTTP through `HTTP_PROXY`, WebSockets through
Coco's documented `webSocketFactory` option (Bun's WebSocket ignores `HTTP_PROXY`). Traffic that
bypassed the link would fail instead of reaching a mint unobserved, and the link refuses and counts
requests that name no known mint (`unrouted`). The link forwards HTTP to the mint's gateway, adding
the Wallet's tag in the gateway's operation header so gateway rules can target one Wallet, and
tunnels WebSocket upgrades to `/v1/ws` straight to the mint, which the gateway cannot carry. When
the gateway drops an exchange, the link drops the Wallet's connection rather than answering. It
never alters a delivered body. The harness probes each mint directly and opens Wallet stores
read-only. It never repairs Wallet state.

A crash is `SIGKILL` of a Wallet process. A `restart` step disposes a running Wallet gracefully,
or starts a crashed one, as a new process and Coco Session over the same store and Wallet Seed. The
trace records which; a graceful restart is never counted as crash coverage.

## Workload

Plans are data (`scenarios.ts`). Commands: `fund`, `send` (creates a token), `receive` (delivers a
token: prepare and execute a Receive), `reclaim`, `raceReclaim`, `restart` and, in explicit-recovery
scenarios, `recover`. Faults are listed under [Faults](#faults); `heal` and `checkpoint` complete the
steps. Token delivery is separate from token creation, so tokens can stay
undelivered or be delivered more than once. Transfers stay within the token's mint.

`workload.ts` gives each step its meaning. `planWorkload(plan)` rejects steps whose state
preconditions do not hold (`PlanPreconditionError`) and derives, without consulting Coco:

- the Wallets and tokens a step occupies, and whether it is a barrier;
- the expected Receive (`finalized`, `rejected`, `either`) and reclaim (`rolled_back`, `rejected`,
  `either`) result: a delivery or reclaim of a token whose value was already claimed is rejected;
- each token's fate (`outstanding`, `received`, `reclaimed`, `raced`), from which the expected Send
  and Receive operation states follow.

A `raceReclaim` without `lead` starts the recipient's Receive execution and the sender's reclaim
together; either may win, exactly one must. With `lead`, the lead's swap response is held at the
gateway after the mint commits it while the follower runs, so both supported outcomes are exercised
deliberately and the trace shows the two commands overlapped. Led races run exclusively.

`generateWorkload(options)` draws commands from a seeded PRNG among those whose preconditions hold
in the same model: funding of every Wallet at every mint, then sends, deliveries, duplicate
deliveries to the recipient or another Wallet, reclaims, late reclaims, led and unled races and
restarts, with periodic checkpoints. Some tokens are withheld and stay outstanding. The model's
spendable amounts are conservative lower bounds that keep commands meaningful; they never define
expected balances. A scenario seed is distinct from Wallet Seeds and reproduces generated choices,
not process scheduling.

With `faults: true`, `generateWorkload` also draws fault interactions, each closing its own faults:
a Receive under a lost swap request or response; a withheld Receive response with a crash and
restart; delayed responses during a Receive, then healing; a recipient outage during its Receive
followed by the recovery mode's progress step; a sender outage while its token is claimed; a
WebSocket drop while a Send is pending; a crash of an idle sender while its token is claimed; and a
bounded number of mint restarts. A checkpoint after a fault is preceded by `heal`. Interrupted
Sends are left to fixed scenarios: an exact-match Send performs no swap, so its exchange fault
would never fire. Fault-free generation is unchanged, so `WORKLOAD_GENERATOR_VERSION` stays 1.

## Faults

Every fault is triggered by a request or an event, and every installed fault must fire; one that
does not leaves the run `unresolved`. `faults.ts` installs them and records the evidence.

| Step                       | Mechanism                                                                                         | Fired when                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `dropRequest`              | gateway `before_forward` drop of the Wallet's next swap                                           | the rule applied                                   |
| `dropResponse`             | gateway `after_downstream_response` drop: the mint answered, the Wallet never hears               | the rule applied                                   |
| `withholdResponse`         | gateway holds the swap response for 10 minutes; the command crashes its Wallet on firing          | the rule applied                                   |
| `delayResponses`           | gateway delays the Wallet's next `count` responses until `heal`                                   | the rule applied                                   |
| `disconnect` / `reconnect` | link closes the Wallet's connections to the mint, including WebSockets, and refuses new ones      | a connection was closed or refused                 |
| `dropWebSockets`           | link waits for an open WebSocket, then closes it without a close frame                            | a socket closed                                    |
| `crash`                    | `SIGKILL` of the Wallet process; it stays down until `restart`                                    | always                                             |
| `restartMint`              | link refuses the mint's connections, `docker kill`, `docker start` over the same storage and port | the mint reports the same keysets and proof states |

Exchange faults and delays are scoped to one Wallet and consumed by its own next swap at that mint,
so they do not serialize other Wallets. The model only lets a Send or a first Receive consume an
exchange fault, rejects other commands of that Wallet at that mint while one is armed, and rejects
commands whose behavior under an outage is not modelled. An exposed command may fail; that is
recorded as `interrupted`, not a wallet failure, and its operation must still reach the expected
state. A lost Receive exchange recovers inline in Coco. A Send interrupted by any fault, or a
Receive interrupted by an outage or crash, stays `executing` until its Wallet restarts (startup
recovery) or, in explicit scenarios, calls `recover`; until then the model refuses further commands
on its token, and the releasing step is ordered before them. An interrupted Send's token is read
through `ops.send.get` once it is pending.

`ScenarioRun.exchanges` corroborates each exposed command outside the Wallet: whether the mint spent
the operation's inputs (a request lost before the mint must leave them unspent; a response lost
after it must follow a spend), the persisted operation state, and the Wallet's swap and restore
requests during it. `mintRestarts` records the restart times, downtime and whether keysets and every
known proof state were retained; anything else is an infrastructure failure.

## Recovery modes

`automatic` scenarios never call a recovery interface: progress must come from Coco, including
inline recovery and startup recovery after `restart`. The model rejects `recover` in them and the
Wallet actor refuses it. `explicit` scenarios may `recover` once every fault has healed: networking
repair (`ensureSubscriptions`) and the Send and Receive recovery sweeps. Its return proves nothing;
`ScenarioRun.recoveries` records which operation states it changed, and checkpoints judge the
outcome.

`heal` removes every gateway rule, ends every outage after it has affected traffic, gives delays a
bounded chance to fire, and then establishes health: each mint answers directly, and every
Wallet's link path reaches it over HTTP and WebSocket. The harness samples the current operation
states as the healthy baseline, then starts the recovery deadline (the plan's
`recoveryDeadlineMs`, 60 s by default) and observes pending outcomes alongside foreground work. Failure to establish health,
including a mint that does not come back, is an `infrastructure_failure`. A checkpoint requires a
healed environment, and a plan must end healed. A healthy environment with an unmet outcome at the
deadline is a `wallet_failure`, never a pass as "safely blocked".

## Scheduling

Steps are dispatched in plan order. A step starts once its Wallets' and its token's earlier steps
have settled, so each Wallet has at most one foreground command outstanding while different Wallets
act concurrently. Barrier steps wait for all earlier steps and block later ones: checkpoints,
healing, led races, Wallet-unscoped `withholdResponse`, outages, WebSocket drops, crashes and mint
restarts.

## Outcomes and evidence

A `checkpoint` waits for every Wallet to be idle, collects the recovery observations and runs the
checker. A success observed during the window remains on time even if later work delays the
checkpoint; a missed deadline remains a failure even if recovery subsequently finishes. New
operations and changed token fates introduced after healing get their own bounded observation at
the checkpoint. These observations never call recovery interfaces. A later `heal` replaces an
unfinished window, retaining any deadline misses already incurred. Observation tasks are drained
before teardown. A plan always ends with a checkpoint, and a failed one stops further dispatch.

`accounting.ts` checks value independently of Coco's displayed balances. Proof states come from the
mints, token contents from the harness's own decoding, and fees from each mint's keyset input fee
rate, rounded once per swap. Proof identities, fee rates and swaps are scoped by mint, and swaps
also by Wallet. It reports, per mint, `funded = held + outstanding + stranded + fees + unexplained`.
For each token it requires exactly one winning claimant once the token is spent: a `finalized`
Receive or a `rolled_back` Send. The winner must be one the plan allows. Per Wallet and mint it
compares held value with funding, sent tokens, won claims net of their fees and own swap fees.
Displayed balances, operation states and history are corroborated against that ledger. A spent
input that cannot be attributed to its swap, or an unobserved claimant, leaves the result
unresolved.

Runs end as `pass`, `wallet_failure`, `unresolved` (missing evidence or an unestablished scenario
precondition, such as a fault that never fired) or `infrastructure_failure`. Only `pass` passes,
except that negative controls expect `wallet_failure`, or `infrastructure_failure` for an
`infrastructureControl` (`mintDoesNotRestart`). A plan's `checkerControl`
(`hideHeldProof`, `duplicateHeldProof`) tampers with collected evidence, never with Wallet state, to
show the checker detects lost or duplicated value in evidence from a real run.

Artifacts are written under `.cache/fault-simulation/runs/<run>/` (override with
`COCO_FAULT_SIM_ARTIFACTS`):

- `trace.json`: portable, redacted plan (with any scenario seed), component versions,
  configuration, ordered events, fault evidence, per-checkpoint verdicts, race winners and command
  counts. Tokens appear as references. Writing fails if any registered Wallet Seed, token or proof
  secret would appear in it.
- `gateway-<mint>.log` and `transport-link.log`: gateway and link process output.
- `private/`: Wallet Seeds, SQLite stores and Wallet process logs. It is removed when a run meets its
  expectation and kept otherwise, or always with `COCO_FAULT_SIM_KEEP_PRIVATE=1`. Never publish it.

## Evidence, replay and minimization

A run's directory keeps its evidence before the world is torn down, and nothing later writes to it.
Replays and minimization runs are new runs in their own directories.

- **Trace formats.** `readTrace` reads the current `trace/v2` and S1 `trace/v1` traces. A v1 plan is
  translated (implicit `mint-a`, `awaitRequirements` becomes a checkpoint) only when each listed v1
  requirement is implied by the workload model; recorded events and results are kept verbatim. Any
  other format, a v1 step without an equivalent, or an unimplied requirement is an explicit
  `UnsupportedTraceError`. Fixtures under `fixtures/` are sanitized real traces.
- **Replay** (`replay.ts`) runs the recorded commands and fault plan exactly as recorded, from clean
  state with fresh Wallet Seeds. It never regenerates commands; for a generated plan it reports
  whether the current generator still produces them (`reproduces`, `differs`, `not_regenerable`).
  A recorded step whose state precondition no longer holds, or whose kind this harness cannot run,
  is refused. `replay.json` in the replay's directory compares the runs: `reproduced` (same failure
  identity), `not_reproduced`, `different_failure`, `inconclusive` (infrastructure), or for an
  original that met its expectation `consistent` / `diverged`, plus changed component versions. A
  replay never resolves the original failure: it stays `unresolved` until a fix is shown.
- **Failure identity** is the outcome, the failing findings by code, mint and Wallet, the kind of a
  contradicted command and the error class of an unresolved run. Amounts, operation IDs and step
  indices are excluded.
- **Minimization** (`minimize.ts`) is best effort and bounded by a run budget. Passing original
  outcomes are rejected, including negative controls that unexpectedly passed: an empty passing
  plan would not preserve the defect the control should detect. For a non-passing outcome, it confirms the
  failure reproduces, then removes groups of steps, never the final checkpoint. A candidate is run
  only if the workload model accepts it, every fault-triggered crash still has its fault installed
  and every fault is still followed by healing. It is kept only if its run fails with the same
  identity; passing, differently failing and erroring candidates are rejected and recorded. Results
  (`minimization.json`, `minimized-plan.json`) go to `.cache/fault-simulation/minimizations/`. The
  minimized plan drops `generator` and records the original run and generator as `derivedFrom`.
- **Reports** (`report.ts`) are built from observations, not plans: commands by result, faults
  that fired and installed faults that never fired, corroborated crashes, restarts after a crash
  versus graceful ones, recovery modes, races, checkpoints, gateway requests, accounting
  differences, and event types the report does not interpret.
- **Portable export** (`artifacts.ts`) copies the trace unchanged plus `report.json` and `report.md`
  and any top-level logs. Everything exported is scanned for raw tokens, Wallet-Seed-shaped and
  proof-secret-shaped hex, secret fields and the retained Wallet Seeds themselves; a trace that
  fails the scan is not exported at all, and a failing log is withheld with the reason. `private/`
  is never exported. Clean-state replay needs no private inputs; Wallet Seeds and stores are
  retained only to inspect the original Wallet state, in an owner-only directory
  (`inspectPrivateRetention`).

## Interfaces for fault and artifact work

- **Commands:** add a `ScenarioStep` kind in `scenarios.ts`, its preconditions and scheduling in
  `WorkloadModel.apply`, and its execution in `runStep`. A new command kind that needs no `heal`
  belongs in `minimize.ts` `NON_FAULT_KINDS`.
- **Faults:** `FaultController` in `faults.ts`. Gateway rules scoped to a Wallet use `walletTag`;
  link faults use `TransportLink`. Record `fault_installed` with `ruleId`, `mint` and `kind`, and a
  `FiredFault` once it applied.
- **Wallet actor:** `WalletActor.request()` accepts `addMints`, `fund`, `prepareSend`,
  `executeSend`, `sendToken`, `prepareReceive`, `executeReceive`, `reclaim`, `observe`, `recover`
  (explicit scenarios only) and `dispose`; `crash()` sends `SIGKILL`; `shutdown()` reports whether
  disposal completed.
- **Observations:** `ScenarioRun` exposes `checkpoints`, `commands` (with any `exposure`), `races`,
  `faultsFired` (with `kind`, `wallet` and `step`), `crashes` (with `trigger`), `exchanges`,
  `recoveries`, `mintRestarts`, `transport` and the final `verdict`. The trace holds the same, plus
  the ordered events.

## Modules

| Module                    | Responsibility                                                           |
| ------------------------- | ------------------------------------------------------------------------ |
| `scenarios.ts`            | Scenario plans as replayable data                                        |
| `workload.ts`             | Step preconditions, expected outcomes, token fates and seeded generator  |
| `runner.ts`               | World lifecycle, scheduling, step execution, evidence, outcomes          |
| `walletActor.ts`          | Harness handle for a Wallet process: commands, crash, shutdown           |
| `walletActorProcess.ts`   | The Wallet process: one Coco Session over SQLite                         |
| `faultLabGateway.ts`      | Thin adapter over the pinned Fault Lab HTTP gateway                      |
| `transportLink.ts`        | Harness handle for the transport link: proxies, outages, WebSocket drops |
| `transportLinkProcess.ts` | The link process: per-Wallet proxy to gateways and mint WebSockets       |
| `faults.ts`               | Fault installation, firing evidence, mint restarts, healing and health   |
| `environment.ts`          | Mint containers and infrastructure failure classification                |
| `evidence.ts`             | Read-only store queries, direct mint probes and token decoding           |
| `accounting.ts`           | Independent fund accounting checker                                      |
| `trace.ts`                | Redacted trace writer and v1/v2 trace reader                             |
| `replay.ts`               | Clean-state replay of recorded commands and replay comparison            |
| `report.ts`               | Failure identity, exercised coverage and portable reports                |
| `minimize.ts`             | Bounded failure minimization preserving preconditions and identity       |
| `artifacts.ts`            | Portable export, secret scanning and private input retention             |

A run killed with `SIGKILL` can leave mint containers behind; `docker ps --filter name=coco-faultsim-`
lists them.
