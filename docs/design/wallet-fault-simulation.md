# Wallet fault simulation

Status: design confirmed. The first implementation step, the Fault Lab adoption experiment, is
implemented in [the fault simulation harness](../../packages/core/test/fault-simulation/README.md);
the remaining milestone is not.

Implementation specification: [GitHub issue #616](https://github.com/cashubtc/coco/issues/616).

## Purpose

Add randomized interactions between real Wallets and real mints alongside the existing test suite.
The primary requirement is to preserve funds through failures and ensure that recoverable funds
become usable again after the environment heals. Safe but permanently blocked funds do not satisfy
that requirement when Coco's recovery contract promises progress.

Use the existing [Coco Cashu vocabulary](../../packages/core/GLOSSARY.md), particularly Wallet,
Coco Session, Ambiguous Operation Outcome, and Operation Recovery. Restore remains a distinct
activity; a process restart does not itself imply loss of persisted wallet state.

## Agreed scope

- Test Coco's happy path and failure recovery. Mints are assumed to follow the protocol; faulty or
  malicious mint implementations are outside the intended scope.
- Inject HTTP/network failures, temporary offline periods, and process crashes. Preserve committed
  mint and wallet storage across restarts. Permanent storage loss is outside the initial fault model.
- Use real mint protocol implementations and real wallet persistence. Fake Lightning or equivalent
  payment backends are acceptable initially; these runs do not establish real Lightning settlement
  correctness.
- Require safety during disruption and supported Operation Recovery after healing. The harness must
  not repair the wallet database or reconstruct proofs on Coco's behalf to make a run pass.
- Coco owns the workload and pass/fail requirements. Selectively evaluate Cashu Fault Lab through a
  thin adapter and a pinned revision. Reuse its gateway and build a Coco driver if adopting its runner
  would require extensive changes or a second wallet recovery implementation.

The ownership decision is recorded in
[ADR-0018](../../packages/core/docs/adr/0018-keep-wallet-simulation-correctness-owned-by-coco.md).

## Fund accounting and recovery

Account for funded value across the whole test world, including wallet funds, outstanding transfers,
external payments, and legitimate mint fees. Do not count the same economic claim twice when both
wallet and operation records refer to it. A temporary balance reduction is not by itself fund loss.
After healing and the prescribed recovery, interrupted operations must reach their expected
outcomes. Unexplained deficits and indefinitely stranded claims fail the run; intentionally
undelivered tokens remain separately accounted for.

Test automatic recovery and caller-invoked recovery as distinct scenarios. Startup recovery and
explicit public recovery calls are both in scope under the existing contracts. An automatic-progress
scenario must not be rescued by an explicit recovery call. A caller-driven scenario may invoke the
documented public interface, but must assert the resulting operation and fund state rather than just
successful return from the call. Coco's own recovery may use mint restoration internally; the test
harness must not reconstruct proofs for it.

The checker maintains an independent ledger of funding, delivered tokens, completed transfers, and
fees. Corroborate it with public wallet outcomes, persisted proof and operation records where
necessary, and mint evidence. Read-only inspection is permitted; modifying wallet state is not.
Missing evidence must remain an unresolved check or failure and must never become an assumed pass.

## First milestone

- Three Wallets and two mints, with persistent SQLite storage for the Wallets.
- Initial funding, ordinary Send, token delivery, Receive, reclaim, and process restart.
- Transfers within each mint, including duplicate token delivery and a recipient racing a reclaim.
- Mint Swap, melting, Restore after storage loss, and spending conditions are deferred to later
  milestones.

## Faults and concurrency

The initial fault palette includes dropped requests, dropped responses, delayed responses, temporary
wallet-to-mint disconnections, WebSocket disconnects, abrupt wallet termination, and mint restarts
preserving storage. Delivered intact responses remain protocol-correct. Outages are finite, healthy
intervals allow progress, and every run ends with a fault-free healing phase.

Initially allow one outstanding foreground command per Wallet, with different Wallets acting
concurrently. Background Watchers and Background Processors remain enabled. Deliberately coordinate
receive-versus-reclaim races across Wallets; concurrent foreground commands within a single Wallet
are a later expansion.

## Recovery deadline and run outcomes

First establish that the intended processes and network paths are healthy. Then apply a configurable
recovery deadline, initially 60 seconds. Observe progress and resulting states rather than using
fixed sleeps as evidence of completion.

If the environment is healthy but the required wallet outcome is missing, the scenario fails. If
environment health cannot be established, report an infrastructure failure. Neither outcome counts
as a pass. The recovery deadline is a test bound, not a new public latency guarantee for Coco.

## Replay

Initially require scenario-level replay from clean state: retain generated commands, fault triggers,
and observed ordering. Prefer request/event-based fault triggers over elapsed-time guesses. A seed
reproduces generated choices, not operating-system scheduling across real processes and networks.
Full deterministic simulation is outside the first milestone. Turn discovered bugs into focused
regression scenarios with controlled ordering.

## Execution and coverage

Run a small fixed scenario corpus and a few fixed seeds on relevant pull requests. Run bounded
randomized workloads nightly and allow arbitrary scenario seeds locally. Establish concrete runtime
budgets from the first implementation measurements. Report the operations, fault points, and recovery
modes actually exercised; a successful run does not imply coverage of combinations it never reached.
A passing rerun must not erase the original failure.

## Failure artifacts

Produce a portable redacted report with the scenario seed, commands, fault triggers, observed
ordering, operation states, accounting differences, and component versions. The scenario seed is
distinct from Wallet Seeds. Do not include Wallet Seeds, proof secrets, or raw tokens in normal logs
or reports; represent secret-bearing command inputs with references in the portable trace.

Keep any necessary secret-bearing replay inputs and database snapshots in separate private files,
outside normal logs and public CI artifacts. Preserve failure evidence before cleaning up the run's
environment. A portable report alone need not contain everything required to replay a secret-bearing
scenario; make its private-input requirements explicit.

## Regression workflow

Every confirmed wallet bug should produce a focused regression scenario alongside its fix. Retain
the original failing trace and attempt to remove irrelevant commands while preserving valid scenario
preconditions and the same failure. Minimization is best-effort. Failure to reproduce or minimize a
run leaves it unresolved; it does not convert the failure into a pass.

## Current implementation facts

Session initialization performs Operation Recovery even when background owners are disabled.
Networking repair alone does not perform another recovery sweep. Ordinary Receive operations expose
explicit recovery, and their recovery calls can return while the operation remains unresolved; tests
must inspect the resulting state. See [Manager](../../packages/core/Manager.ts),
[ReceiveOpsApi](../../packages/core/api/ReceiveOpsApi.ts), and the
[session networking contract](../../packages/core/README.md).

Wallet balance totals exclude outstanding Send proofs and mint-held pending proofs. Reclaim can
incur input fees and can race with a recipient's claim. A sum of displayed wallet balances therefore
cannot establish fund conservation during an interrupted transfer. See
[BalanceQueries](../../packages/core/proofs/BalanceQueries.ts),
[SendOpsApi](../../packages/core/api/SendOpsApi.ts), and
[ADR-0012](../../packages/core/docs/adr/0012-distinguish-mint-held-pending-proofs.md).

## Candidate infrastructure

The source assessment used Cashu Fault Lab revision
[`1cc954d33a1088fd20efc48c5437e3a7441920f7`](https://github.com/GautamBytes/cashu-fault-lab/tree/1cc954d33a1088fd20efc48c5437e3a7441920f7).
It identified the HTTP fault gateway, wallet-lifecycle runner, scenario corpus, and replay tooling
as reuse candidates. This was a source inspection, not an executed integration or a dependency
selection. Its [lifecycle guide](https://github.com/GautamBytes/cashu-fault-lab/blob/1cc954d33a1088fd20efc48c5437e3a7441920f7/docs/wallet-lifecycle.md)
describes the experimental suite and its evidence limits.

Before adopting the candidate infrastructure, prove a genuinely funded Receive whose successful
mint response is lost, followed by abrupt wallet termination, restart using the same storage, and
successful Coco Operation Recovery. Require a thin adapter, a replayable trace, and a checker that
also detects a deliberately introduced failure.

Reuse the gateway if it passes this experiment. Retain the runner only if it accommodates independent
accounting, multiple Wallets, and Coco's recovery requirements without duplicating Coco's state
machine. Otherwise build the driver within Coco's test tooling. Passing the experiment establishes
the first integration step; it does not by itself establish all fault or workload coverage above.

## Fault Lab adoption experiment

The harness ran the adoption experiment against revision `1cc954d3` with `cashubtc/mintd:0.17.0-rc.0`
(`fakewallet`, unit `sat`, 100 ppk input fees). One Wallet funded 64 and sent 32. The gateway held
the mint's response to the receiving Wallet's `POST /v1/swap`. The harness observed the rule fire,
confirmed directly at the mint that the token inputs were spent, and sent `SIGKILL` to the Wallet
process while its Receive was still `executing` in SQLite. A new Coco Session over the same store and
Wallet Seed finalized the Receive during startup Operation Recovery, without an explicit recovery
call. Independent accounting matched: 64 funded = 31 + 31 held + 2 input fees. The same scenario
replayed from clean state using only its recorded plan. A negative control that never restarts the
Wallet reports the 31 missing value and the unmet outcome. Disabling Coco's startup Receive recovery
makes the scenario fail at the 60 second deadline.

Decision:

- **Reuse the gateway.** Consume the pinned revision through a verified Git checkout. Bundle its
  `http-fault-gateway` for Node and run it as a separate process controlled through its
  `/__faults/v1/` API. Run it under Node. Under Bun's `node:http`, `drop` becomes an empty `200`.
  Upstream declares Node 24; the experiment ran on Node 22.22.1.
- **Do not adopt the runner.** The lifecycle driver models one adapter and its own operation state
  machine with caller-assigned operation IDs, so a Coco adapter would duplicate Coco's state machine.
  Its quiescence check accepts `recovery_blocked`, which fails a Coco progress requirement. It has no
  multi-Wallet accounting for outstanding tokens and fees, and its triggers are by request occurrence
  rather than events that can terminate a process. Coco's test tooling owns the driver.

Gateway limitations for later work:

- It has no WebSocket upgrade handling. Coco's `GET /v1/ws` reaches it as plain HTTP and fails, so
  WebSocket faults need an extension.
- Rules match by method, path and occurrence, not by Wallet. One gateway per mint therefore relies on
  scenario sequencing to target a Wallet.
- Its evidence omits downstream status codes. Mint acceptance is corroborated by direct mint probes.
- It forwards only `accept` and `content-type` request headers and caps responses at 64 KiB.
- Bun's `fetch` retries an idempotent `GET` once when a reused connection closes, so a dropped `GET`
  response can be masked at the client. A `POST` is not retried.
