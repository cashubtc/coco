# Send transaction migration

PR #463 adapts Send to the transaction architecture merged in PR #461. The baseline is master at
`a8952b3491c7e5eee67f5e186f6ade3db52727c0`, including the final input naming and coverage conventions.
[Transaction Design](../../TRANSACTION_DESIGN.md) and
[ADR-0011](../../packages/core/docs/adr/0011-use-domain-transaction-gateways.md) govern the migration.

## Scope

Preserve the existing public Send APIs, plugin operation methods, supported methods, token behavior,
and persisted request compatibility. Migrate preparation, exact execution, swap execution, completion,
cancellation, pending default-token reclaim, and cleanup to the current transaction boundaries.

`init` is a transient intent, not work to resume. Startup releases any reservations owned by legacy
`init` records and deletes those records in one transaction. New preparation commits directly to
`prepared`. Committed output positions are never reclaimed.

## Ownership and dependencies

- `SendOperationService` owns preflight, committed transitions, protocol calls, and post-commit
  events. Method handlers return synchronous local preparation policy and disclose reclaim support.
- `SendTransactions` owns one runner invocation per method. Its gateways receive only the runner.
- `ScopedSendCommands` composes proof reservation and settlement, Output Allocation, and operation
  persistence inside one adapter scope. Shared proof and output implementations live under
  `transactions/scoped/`; selection, fee calculation, and output validation are reusable pure logic.
- `MintQueries` and `ProofQueries` read existing storage. Send receives only mint trust queries and
  `Pick<MintService, 'refreshAndCommitIfStale'>`. The shared action owns freshness policy,
  `CashuMintMetadataRemote` fetching, `MintMetadataTransactions.applyObservation`, and post-commit
  mint events. Its independent commit survives a later Send failure. `ensureUpdatedMint` delegates
  to the same action for legacy callers. Send's gateway and remote interface no longer own metadata
  refresh. Preparation still rechecks trust and active keys in its reservation transaction.
- Existing MintService add, forced-update, trust, and delete paths retain their legacy dependencies;
  their full migration is separate. The new shared action only acquires Queries, remote observation,
  its own gateway, and event publication through its implementation dependencies.
- `CashuSendRemote` constructs a Wallet Instance from committed metadata and performs swap,
  proof-state checks, and reclaim without persistence authority. Remote output restoration and
  unblinding are shared with remaining `ProofService` callers; persistence stays with the caller.
  Swap and reclaim explicitly select their persisted output keyset for unblinding and reject empty
  or mixed-keyset output plans before mint I/O.
- The current `TransactionLifetime` binds repositories and exposed commands, drains started work,
  rejects failed or expired scopes, and keeps retries outside rolled-back transactions.

## Naming

`SendOperationService` retains its name because it coordinates a durable saga. Shared behavior uses
Queries, local capabilities, and `Scoped*Commands`; shared reuse alone does not make a module a
Service. `SendTransactions` owns committed transitions, while scoped command methods run inside the
owning transaction.

Method-specific argument objects use `*Input` types and the parameter name `input`, such as
`prepare(input: PrepareSendInput)` and `allocate(input: AllocateOutputsInput)`. Transaction runner
callbacks use `work`. Existing domain values retain their specific names, such as
`applyObservation(observation)` and `cleanupLegacyInit(operationId)`.

## Persisted request compatibility

Send retains the original input-secret references, output plan, and execution memo. Referenced proof
request fields remain unchanged when proof state or ownership metadata changes. Memory reads and
writes copy nested values so caller-owned objects cannot mutate that stored request material.

Reclaim has a separate optional `reclaimData` field containing its input references and output plan.
The `pending` to `rolling_back` transaction commits this plan with its Output Allocation. The result
transaction validates returned proofs against the plan, saves them, spends the reclaimed inputs,
releases this operation's remaining reservations, and records `rolled_back` atomically.

SQL migration `041_send_reclaim_data` adds a nullable field without rewriting existing request
material. IndexedDB tolerates records without the field. The original Send request remains intact.

Automatic recovery of interrupted reclaim remains outside this refactor. Both old and new
`rolling_back` records retain the existing startup warning and manual seed Restore path. The
Send mint-error classification now recognizes an explicit set of request-validation rejections from
[NUT error codes](https://github.com/cashubtc/nuts/blob/main/error_codes.md). Unknown codes retain the
executing request and its reservations, just like known ambiguous outcomes. Replay errors always
retain the request because an earlier submission may still complete. An initial validation rejection
can release resources only while its authorizing revision is still current; a recovery claim fences
that failure. A successful response can still settle the immutable request after a recovery claim.

Reservation cleanup releases only proofs owned by known terminal Sends. A missing Send record does
not establish orphanhood: the reservation may belong to Melt or another workflow. Unidentified
owners remain reserved until their owning workflow or a future ownership-aware repair can establish
safe release.

## Verification coverage

Send tests cover atomic preparation, concurrent reservations, execution and cancellation conflicts,
post-commit events, exact replay, ambiguous outcomes, reclaim allocation/result rollback, and startup
cleanup. Protocol tests exercise the real cashu-ts client with in-memory mint responses for default
and P2PK swaps, reclaim, and output restoration. Storage contracts cover request immutability,
conditional revisions, and reclaim-plan round trips; migration tests retain existing recovery data.

Shared metadata action tests cover fresh-cache reuse, normalized URLs, remote I/O outside
transactions, atomic refresh failure, post-commit events and listener failures, and a refresh
remaining committed after Send preparation fails. Uniform rejection of nested Wallet transactions
is follow-up work; the action must never be injected into gateways or scoped commands.
