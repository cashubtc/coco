# Send transaction migration

PR #463 adapts Send to the transaction architecture in PR #461. The baseline is #461 at
`19f6ecb5fe856b70ba27442900c48ba053f672b0`; the original Send slice is #463 at
`b4ff6278ee285ed384fc85c736dc3af87d406f11`.
[Transaction Design](../../TRANSACTION_DESIGN.md) and
[ADR-0011](../../packages/core/docs/adr/0011-use-domain-transaction-gateways.md) govern the migration.

## Scope

Preserve the existing public Send APIs, plugin operation methods, supported methods, token behavior,
and Operation Recovery decisions. Migrate preparation, exact execution, swap execution, completion,
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
- `MintQueries` and `ProofQueries` read existing storage. Mint metadata refresh is explicit:
  `SendRemote` returns an observation, Send's gateway commits the cache through shared scoped mint
  metadata commands, and the coordinator publishes events after commit. Preparation rechecks trust
  and active keys in the transaction that authorizes the reservation.
- `CashuSendRemote` constructs a Wallet Instance from committed metadata and performs swap,
  proof-state checks, and reclaim without persistence authority. Remote output restoration and
  unblinding are shared with remaining `ProofService` callers; persistence stays with the caller.
- The current `TransactionLifetime` binds repositories and exposed commands, drains started work,
  rejects failed or expired scopes, and keeps retries outside rolled-back transactions.

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
existing Send mint-error classification policy is preserved.

## Verification coverage

Send tests cover atomic preparation, concurrent reservations, execution and cancellation conflicts,
post-commit events, exact replay, ambiguous outcomes, reclaim allocation/result rollback, and startup
cleanup. Protocol tests exercise the real cashu-ts client with in-memory mint responses for default
and P2PK swaps, reclaim, and output restoration. Storage contracts cover request immutability,
conditional revisions, and reclaim-plan round trips; migration tests retain existing recovery data.
