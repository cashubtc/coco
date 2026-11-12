# Wallet fault simulation

Test-only harness for the [wallet fault simulation design](../../../../docs/design/wallet-fault-simulation.md)
([spec #616](https://github.com/cashubtc/coco/issues/616)). Coco owns the workload and pass/fail
requirements ([ADR-0018](../../docs/adr/0018-keep-wallet-simulation-correctness-owned-by-coco.md)).

## Run

Prerequisites:

- Docker and Git.
- Network access on first use, to fetch the pinned Fault Lab revision and the mint image.
- Bun 1.3.14 or newer. Bun 1.3.11's `fetch` resends a POST whose connection dropped, so dropped swap
  requests and responses never reach Coco; the transport link test fails under it, and the suite
  refuses it.
- Node.js for the gateway and transport link processes. The pinned Fault Lab declares Node
  `>=24 <25`. CI uses Node 24.22.2 with Bun 1.3.14 and enforces the range (`--strict-runtime`).
  Node 22.22 also works locally, and the suite records that as a warning.

Run from the repository root:

```bash
bun run test:fault-simulation                                     # fixed corpus, fixed seeds (as on PRs)
bun run test:fault-simulation:nightly -- --random-seeds 2         # fixed corpus, random seeds
bun run test:fault-simulation:seeds -- --seeds 11,12 --fault-seeds 7   # arbitrary seeds only
bun run fault-simulation:replay <runDir>/trace.json               # clean-state replay
bun run fault-simulation:minimize <runDir>/trace.json 24          # best-effort minimization
bun run fault-simulation:report <runDir>/trace.json...            # report, or aggregate coverage
bun run fault-simulation:export <runDir> <outDir>                 # scanned portable export
```

The `test:fault-simulation*` scripts run `suite.ts`, which builds core (the SQLite repositories
import its build output), checks prerequisites, runs the selected `*.sim.ts` files with `bun test`
under a wall-clock budget and then judges the evidence. `*.sim.ts` files are outside the default
`*.test.ts` glob, so plain `bun test` and the unit and integration runners never select them. To run
one scenario directly while developing, build core and filter by name:

```bash
bun run --filter='@cashu/coco-core' build
bun test ./packages/core/test/fault-simulation/faultPalette.sim.ts -t 'mint restart'
```

Profiles:

| Profile   | Files                                     | Scenario seeds                                      | Corpus coverage gate | Default budget      |
| --------- | ----------------------------------------- | --------------------------------------------------- | -------------------- | ------------------- |
| `pr`      | all three `*.sim.ts`                      | fault-free `1,2`; fault `5,18`, both recovery modes | required             | 20 min              |
| `nightly` | all three `*.sim.ts`                      | `--random-seeds N` (default 3, at most 5) of each   | required             | 20 + 9 min per seed |
| `seeds`   | the generated tests of the selected seeds | `--seeds`, `--fault-seeds`                          | reported only        | 5 + 3 / 6 per seed  |

Seeds are unsigned 32-bit integers. Nightly seeds are drawn at random and recorded in the summary,
so any of them can be rerun with the `seeds` profile. The budget bounds the tests and replays, not
the build or prerequisites, and `--budget-minutes` overrides it. Other options: `--replay-failures`
(the nightly default), `--max-replays`, `--strict-runtime`, `--skip-build`, `--out`. Each replay runs
in its own process group with only the suite's remaining budget; an overrun kills that group and
removes its containers, just as for the tests.

The suite passes (exit 0) only if all of these hold:

- `bun test` passed, and its JUnit report shows that every selected file and every requested seed
  in both recovery modes executed. In the corpus profiles, no test may be skipped.
- Every recorded run met its expectation. The exception is the deliberately failing known-bad plan
  of the evidence tests (`known-bad-*`), whose own tests assert its failure.
- Every run directory exported cleanly: a trace exists and passes the secret scan.
- In the corpus profiles, the aggregate observed coverage shows the following:
  - every palette fault kind fired: dropped request, dropped response, withheld response, delayed
    response, outage, WebSocket drop, Wallet crash, and a mint restart with retained state;
  - both recovery modes;
  - a restart after a crash, and a crash on a request the mint accepted;
  - exchanges interrupted before and after the mint's effect;
  - an explicit recovery that changed an operation;
  - both led race outcomes, a rejected duplicate delivery and a completed reclaim;
  - both negative-control outcomes;
  - no unfired fault and no unrouted Wallet traffic.

Otherwise it exits 1 (failure), 2 (usage), 3 (missing prerequisite: Docker, Node, Bun 1.3.14 or newer,
Git, the Fault Lab revision, the mint image or, with `--strict-runtime`, the Node range) or 4 (budget
exceeded; the active test or replay process group is killed and its containers removed). A missing prerequisite or
an untriggered fault is never a skip.

Output goes to `--out` (default `.cache/fault-simulation/suites/<profile>-<time>/`):

The output directory must be new or empty. Reusing a nonempty directory exits 2 without changing
its evidence, so earlier failures cannot contaminate a later verdict or fill gaps in its coverage.

- `work/` is the harness artifacts root for the suite's runs (`COCO_FAULT_SIM_ARTIFACTS`). It holds
  failed runs' `private/` directories and never leaves the machine.
- `portable/` holds only what the secret scanner approved: `summary.md` and `summary.json` (verdict,
  problems, tests with durations, runs, exercised coverage, coverage gaps, runtime versions),
  `junit.xml`, `test-output.log` and `runs/<run>/` exports (trace, `report.json`, `report.md`,
  gateway and link logs). A file that fails the scan is withheld and named in the summary. CI
  uploads `portable/` alone.

The suite never retries a test. With `--replay-failures` it replays each failed run once from clean
state and records the comparison; a passing replay leaves the original failure and the exit code
unchanged.

`COCO_FAULT_SIM_SEEDS` and `COCO_FAULT_SIM_FAULT_SEEDS` (comma-separated, defaults `1,2` and `5,18`)
select the generated workloads when a `*.sim.ts` file is run directly; the suite always sets them.
The first run fetches the pinned Cashu Fault Lab revision into `.cache/`. Set
`COCO_FAULT_LAB_CHECKOUT` to use an existing checkout; it must be at the pinned revision.

### CI

`.github/workflows/fault-simulation.yml` (`wallet-fault-simulation`) runs on `ubuntu-24.04` with
Bun 1.3.14 and Node 24.22.2:

- **Pull requests and master pushes** that touch `packages/core`, `packages/sql-storage`,
  `packages/sqlite-bun`, `package.json`, `bun.lock` or the workflow run the `pr` profile.
- **Nightly** (03:17 UTC) runs the `nightly` profile with 3 random seeds of each kind.
  `workflow_dispatch` chooses the profile and seed count.
- Every attempt uploads `portable/` as `fault-simulation-<run id>-<attempt>` for 30 days, including
  after failures and budget overruns, so a rerun never replaces the first attempt's evidence.

### Budgets

Measured on a local Linux host (Docker 29.9) with Bun 1.3.14 and Node 24.22.2 unless stated
otherwise. These are measurements, not guarantees. The budgets leave roughly 2× headroom for slower
CI hosts:

| Run                                        | Tests | Tests wall clock         | Budget |
| ------------------------------------------ | ----- | ------------------------ | ------ |
| `pr` profile (two runs)                    | 25    | 434 s and 446 s          | 20 min |
| `pr` profile (GitHub ubuntu-24.04)         | 25    | 429 s                    | 20 min |
| `nightly --random-seeds 1`                 | 22    | 157 s                    | 29 min |
| S3 suite under Bun 1.3.14 and Node 22.22.1 | 22    | 430 s (before the suite) | (n/a)  |

Per test:

- Fixed scenarios and controls: 1–18 s. The transport link test: under 1 s.
- Fault-free generated workloads: 6–13 s per run.
- Generated fault workloads: 8–72 s per recovery mode. Seeds 5 and 18 take 64–72 s, mostly
  Coco's 5 s polling after WebSocket loss and restarts.
- Evidence tests: 3–33 s, including replay and a 14-run minimization.

The fixed seeds 5 and 18 account for about 280 s of the `pr` profile. Image pulls, the Fault Lab
fetch and the core build are outside the budget; the CI job's 75-minute timeout bounds them. The
[first GitHub PR run](https://github.com/cashubtc/coco/actions/runs/43217045134) passed all 25 tests
in 429 s (441 s including suite setup) and uploaded its portable evidence successfully. GitHub
nightly profile also [passed on GitHub](https://github.com/cashubtc/coco/actions/runs/43219759698)
with one random seed of each kind: 22 tests in 145 s (153 s including suite setup), with portable
evidence uploaded.

### Diagnosing a failure

1. Read `summary.md`: the problems name failing tests, runs that missed their expectation,
   selection problems and coverage gaps. In CI it is also the job summary.
2. For a failing run, read `portable/runs/<run>/report.md`. It gives the outcome and failure
   identity, the checker findings with accounting differences per mint, exercised coverage and the
   component versions. `trace.json` holds the ordered events. `gateway-*.log` and
   `transport-link.log` show traffic and fault control.
3. Replay from clean state with the recorded commands and fault plan:
   `bun run fault-simulation:replay <trace.json>`. It exits 0 only for `consistent` or
   `reproduced`. The comparison is written to the replay's run directory, never the original's.
   A downloaded CI trace replays the same way.
4. Locally, a failed run keeps `work/runs/<run>/private/`: the Wallet Seeds, SQLite stores and Wallet
   process logs, owner-only. Use them to inspect the original Wallet state. Never publish them. CI
   discards them with the runner, and clean-state replay does not need them.
5. Distinguish `infrastructure_failure` (health could not be established: fix the environment, the
   failure is not about Coco) from `wallet_failure` and `unresolved` (missing evidence or a fault
   that never fired). None of them is a pass.

### Promoting a failure to a regression

A failure stays unresolved until a fix is shown; a passing replay or nightly rerun does not resolve
it.

1. Keep the original portable trace. Minimize it with
   `bun run fault-simulation:minimize <trace.json> [maxRuns]`. The result is best effort and keeps
   the same failure identity and valid preconditions. It writes `minimized-plan.json` and
   `minimization.json` under `.cache/fault-simulation/minimizations/`.
2. Add the minimized steps as a named plan in `scenarios.ts`, controlling the ordering through
   request- or event-triggered faults rather than sleeps. Give it a test with focused assertions in
   the `*.sim.ts` file for its area, so the `pr` corpus runs it, and confirm the test fails against
   the unfixed Coco.
3. Fix Coco, and also add a regression test at the most direct public boundary the
   [testing standards](../../../../CODING_STANDARDS.md#test-behavior) allow. Rerun the suite.
4. A harness or checker bug gets its own fix and test. For example, S2's false 1-sat deficit is kept
   as the `fixtures/v2-generated-seed-2-false-deficit.trace.json` replay fixture. It never weakens a
   wallet requirement.

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
Wallet's link path reaches it over HTTP and WebSocket. Only then does the checkpoint's recovery
deadline (the plan's `recoveryDeadlineMs`, 60 s by default) start. Failure to establish health,
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

A `checkpoint` waits for every Wallet to be idle, observes without calling any recovery interface
until each expected operation state holds or the recovery deadline passes, and then runs the
checker. A plan always ends with one. A failed checkpoint stops further dispatch.

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
  contradicted command, the error class of an unresolved run, and Wallet outcomes unavailable from
  a live Session at the decisive checkpoint. A Wallet left stopped therefore cannot reproduce a
  failure observed after startup recovery. Amounts, operation IDs and step indices are excluded.
- **Minimization** (`minimize.ts`) is best effort and bounded by a run budget. It confirms the
  failure reproduces, then removes groups of steps, never the final checkpoint. A candidate is run
  only if the workload model accepts it, every fault-triggered crash still has its fault installed
  and every fault is still followed by healing. It is kept only if its run fails with the same
  identity; passing, differently failing and erroring candidates are rejected and recorded. Results
  (`minimization.json`, `minimized-plan.json`) go to `.cache/fault-simulation/minimizations/`. The
  minimized plan drops `generator` and records the original run and generator as `derivedFrom`.
- **Reports** (`report.ts`) are built from observations, not plans. They cover:
  - commands by result;
  - faults that fired, and installed faults that never fired;
  - palette fault kinds exercised (fired gateway and link faults, Wallet crashes, and mint restarts
    that kept their state);
  - crashes by trigger and corroborated mint effect, and restarts after a crash versus graceful
    ones;
  - mint restarts;
  - interrupted exchanges with the mint's effect;
  - operation transitions caused by explicit recovery;
  - recovery modes, races and checkpoints;
  - gateway requests and transport link totals (WebSocket upgrades and fault closures, refused and
    closed connections, unrouted requests);
  - accounting differences;
  - event types the report does not interpret.

  Gateway faults in traces that predate recorded fault kinds are classified by phase and action.

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

| Module                    | Responsibility                                                            |
| ------------------------- | ------------------------------------------------------------------------- |
| `scenarios.ts`            | Scenario plans as replayable data                                         |
| `workload.ts`             | Step preconditions, expected outcomes, token fates and seeded generator   |
| `runner.ts`               | World lifecycle, scheduling, step execution, evidence, outcomes           |
| `walletActor.ts`          | Harness handle for a Wallet process: commands, crash, shutdown            |
| `walletActorProcess.ts`   | The Wallet process: one Coco Session over SQLite                          |
| `faultLabGateway.ts`      | Thin adapter over the pinned Fault Lab HTTP gateway                       |
| `transportLink.ts`        | Harness handle for the transport link: proxies, outages, WebSocket drops  |
| `transportLinkProcess.ts` | The link process: per-Wallet proxy to gateways and mint WebSockets        |
| `faults.ts`               | Fault installation, firing evidence, mint restarts, healing and health    |
| `environment.ts`          | Mint containers and infrastructure failure classification                 |
| `evidence.ts`             | Read-only store queries, direct mint probes and token decoding            |
| `accounting.ts`           | Independent fund accounting checker                                       |
| `trace.ts`                | Redacted trace writer and v1/v2 trace reader                              |
| `replay.ts`               | Clean-state replay of recorded commands and replay comparison             |
| `report.ts`               | Failure identity, exercised coverage and portable reports                 |
| `minimize.ts`             | Bounded failure minimization preserving preconditions and identity        |
| `artifacts.ts`            | Portable export, secret scanning and private input retention              |
| `suite.ts`                | Profiles, prerequisites, budgets, selection and coverage gates, CI output |

A run killed with `SIGKILL` can leave mint containers behind; `docker ps --filter name=coco-faultsim-`
lists them.
