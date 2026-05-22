# NUT-30 Onchain Minting on Decoupled Quote Lifecycle

## Goal

Add NUT-30 onchain minting on top of the decoupled quote lifecycle now present on the
base branch.

The immediate driver is NUT-30 onchain minting, where one quote creates a Bitcoin address and
multiple eligible UTXOs can arrive over time. The wallet must be able to mint any amount up to
`amount_paid - amount_issued`, including partial withdrawals, without treating the quote ID as the
local operation identity.

## Base Branch State

This worktree has been rebased onto the branch that decouples canonical quote lifecycle from mint and
melt operation lifecycle. The older `PR1_QUOTE_FIRST_BOLT11.md` is now historical background rather
than a pending prerequisite. This onchain plan should build on the current base branch instead of
reintroducing quote APIs under operation APIs.

The base branch owns the shared quote groundwork:

- canonical mint quote repository/store keyed by `(mintUrl, method, quoteId)`
- canonical melt quote repository/store keyed by `(mintUrl, method, quoteId)`
- unified public quote access through `manager.quotes.mint` and `manager.quotes.melt`
- BOLT11 mint quote creation through `manager.quotes.mint.create()`
- BOLT11 mint operation preparation only against a pre-created quote via
  `manager.ops.mint.prepare({ quoteId })`
- BOLT11 melt quote creation through `manager.quotes.melt.create()`
- BOLT11 melt operation preparation only against a pre-created quote via
  `manager.ops.melt.prepare({ quoteId })`
- `operationId` as local operation/history identity
- BOLT11 quote migrations
- `mint-quote:updated` for quote-only mint updates, emitted after canonical quote persistence
- `mint-op:*` and `melt-op:*` for operation lifecycle updates

This document should not repeat that work except where the onchain implementation depends on those
invariants.

## Base Branch Progress

- [x] Added method-aware canonical mint quote records keyed by `(mintUrl, method, quoteId)`.
- [x] Added canonical quote repositories for memory, SQLite3, SQLite Bun, Expo SQLite, and
      IndexedDB.
- [x] Added SQLite-style migrations that backfill BOLT11 quote records from existing mint
      operations, including terminal operations, with `reusable: false`.
- [x] Added `manager.quotes.mint.create()` for BOLT11.
- [x] Changed mint `prepare()` to require `quoteId` and consume an existing canonical quote row.
- [x] Changed BOLT11 prepare internals so the handler consumes an existing quote snapshot instead
      of creating remote quotes.
- [x] Added `manager.quotes.melt.create()` and changed melt `prepare()` to require `quoteId` so melt
      quote creation is also separate from melt operation lifecycle.
- [x] Added canonical melt quote repositories for memory, SQLite3, SQLite Bun, Expo SQLite, and
      IndexedDB.
- [x] Changed mint operation quote lookup APIs to require full quote identity and return sibling
      operations deterministically at the repository boundary.
- [x] Updated quote observation paths to update canonical quote records before operation/history
      projection.
- [x] Replaced operation-shaped quote notifications with the quote-level `mint-quote:updated` event.
- [x] Kept `HistoryService`, React operation hooks, and operation consumers on operation events rather
      than quote-only events.
- [x] Added unit, adapter contract, and migration coverage for decoupled BOLT11 quote behavior.
- [x] IndexedDB browser contract tests pass in Chromium after installing the matching Playwright
      browser revision.

## Current Problem

The current mint saga mostly assumes a one-to-one relationship:

- one local `MintOperation`
- one remote quote ID
- one requested amount
- one output set
- one finalization path

That model fits BOLT11 but does not fit reusable quotes. For NUT-30, quote creation does not carry a
fixed amount. The quote later exposes an available balance through `amount_paid - amount_issued`,
and each local mint operation should withdraw from that available balance with its own amount and
deterministic outputs.

## Design Direction

Separate quote tracking from quote withdrawals.

- A remote quote is reference data keyed by `(mintUrl, method, quoteId)`.
- A local mint operation is a withdrawal attempt keyed by `operationId`.
- Multiple local mint operations may share the same `(mintUrl, method, quoteId)`.
- History, events, repository upserts, and UI bindings must use `operationId` as local identity.
- `quoteId` remains searchable metadata, not a uniqueness boundary by itself.
- Quote-only public APIs live under `manager.quotes`; `manager.ops` remains operation-oriented.
- Operation preparation APIs require a pre-created canonical quote. Do not add create-quote wrappers
  back to `manager.ops.mint.prepare()` or `manager.ops.melt.prepare()`.
- Quote records are canonical for quote metadata. Operation-embedded quote snapshots are legacy data,
  not a second long-term source of truth.
- Method-specific quote metadata belongs in typed quote-scoped `quoteData`, not in operation-scoped
  `methodData`. Keep `methodData` for operation execution metadata only.
- Quote observation and quote claiming are separate responsibilities: watchers update canonical quote
  records, while a quote-level processor decides what operation work can claim the issuable balance.
- Automatic claiming is enabled by default when the mint quote watcher/processor is running. A
  manager/watcher option may opt out, but the default live-watcher behavior is to drain claimable mint
  quote balance.
- Automatic claiming is mint-only. Melt operations spend local proofs to an external target and must
  always start from explicit caller/user intent.

## Proposed Model

### Quote Snapshot

Extend the current canonical mint quote repository with reusable onchain quote metadata. New mint
operations reference quote records instead of owning the shared remote quote metadata.
Quote refreshes should update this canonical quote record first. Mint operations should not remain
the long-term owner of `lastObservedRemoteState`/`lastObservedRemoteStateAt`; those fields should be
removed, derived from the quote row, or kept only as legacy/denormalized compatibility data.

Use the method registry to type quote creation input and persisted quote metadata separately from
operation metadata:

```ts
interface MintMethodDefinitions {
  bolt11: {
    methodData: Record<string, never>; // operation-scoped
    createQuoteData: { amount: UnitAmount };
    quoteData: {
      amount: Amount;
    };
    remoteState: 'UNPAID' | 'PAID' | 'ISSUED';
  };

  onchain: {
    methodData: Record<string, never>; // operation-scoped
    createQuoteData: {
      unit: string;
    };
    quoteData: {
      pubkey: string;
      amountPaid: Amount;
      amountIssued: Amount;
    };
    remoteState: never; // NUT-30 mint quotes have no protocol `state` field
  };
}
```

The shared `MintQuote` type must therefore stop requiring universal `amount` and `state` fields.
Model state as method-conditional: BOLT11 quotes carry protocol state, while onchain quotes carry
balance observations in `quoteData`.

Minimum fields for a reusable quote:

- `quoteId`
- `method`
- `request`
- `unit`
- `expiry`
- `quoteData`
- `reusable: true`
- `lastObservedAt` or a method-neutral equivalent for freshness

For BOLT11, `quoteData.amount` is the fixed quote amount and the protocol remote state remains
`UNPAID | PAID | ISSUED`.

For onchain, NUT-30 `PostMintQuoteOnchainResponse` contains `quote`, `request`, `unit`, `expiry`,
`pubkey`, `amount_paid`, and `amount_issued`. It does not include a BOLT11-style `state` field. Store
`pubkey`, `amountPaid`, and `amountIssued` in `quoteData`; compute the remote mintable amount as
`amountPaid - amountIssued`. If shared code needs a readiness category, derive it locally from
`quoteData` and expiry instead of persisting an invented onchain protocol state. NUT-30 also says only
eligible UTXOs increase `amount_paid`; UTXOs below the onchain mint method `min_amount` do not count
and must not be aggregated to satisfy `min_amount`.

### NUT-20 Quote Signing Keys

NUT-20 signing keys belong to the remote quote, not to individual withdrawal operations. Each new
NUT-20-protected quote must get a fresh signing key. Do not reuse a signing key across quotes.

Use the existing seed/keyring infrastructure, but derive quote-signing keys from a separate NUT-20
branch so they do not share the same sequence as user-facing/P2PK keys:

```text
existing keyring branch: m/129373'/10'/0'/0'/{index}
NUT-20 quote branch:    m/129373'/20'/0'/0'/{index}
```

The key repository must track key purpose metadata. Existing user-facing/P2PK keys should use a
default purpose such as `p2pk`; quote-signing keys should use `nut20_mint_quote`. User-facing keyring
APIs such as latest/all/remove should be audited so quote recovery keys do not accidentally appear in
user-managed signing-key flows. The quote record stores the compressed public key as `pubkey`; the
private key remains in the keyring and is resolved by public key during mint execution and recovery.

Conceptual flow:

- Create quote: derive and persist a fresh NUT-20 quote key, then send its `pubkey` in the onchain
  quote request `{ unit, pubkey }` through the quote lifecycle.
- Persist quote: store the returned quote snapshot with the same `pubkey` and full quote identity.
- Prepare withdrawal operation: create operation-owned deterministic output data; do not create a new
  NUT-20 key when reusing an existing quote.
- Execute withdrawal operation: load the quote key by `pubkey`, sign `quoteId || B_0 || ... || B_n`
  for that operation's outputs, and include the signature in the mint request.
- Recover operation: use the persisted quote `pubkey` to load the same quote key and reproduce the
  required NUT-20 signature for the operation's deterministic outputs.

If a quote has a `pubkey` but the matching private key is missing, mint execution for that quote is
not recoverable unless the application can restore or import the missing quote key.

### Quote Creation Atomicity

`manager.quotes.mint.create()` is the primitive for reusable onchain quote creation.
`manager.ops.mint.prepare()` should expect a pre-created quote and should not create remote quotes for
any method.

Quote creation flow:

- Derive and persist the fresh NUT-20 quote key before calling the mint.
- Call the mint to create the onchain quote/address.
- Persist the returned quote row immediately after the remote quote call succeeds.

Residual risk: if the process crashes after the mint returns an onchain quote/address but before the
quote row is persisted, that remote quote may be orphaned at the mint unless the mint or application
provides a separate quote-discovery/import path. This is acceptable because no local operation was
persisted. Keep the local persistence window as small as possible and do not perform unrelated work
between remote quote creation and quote persistence.

Prepare flow:

- Load the canonical onchain quote row by `(mintUrl, method, quoteId)`.
- Validate that required NUT-20 signing material is available.
- Prepare operation-owned deterministic output data in memory. This may advance counters; do not roll
  those counters back if the operation is later dropped.
- Persist the pending operation, including deterministic output data.
- If anything fails before operation persistence commits, drop the in-memory operation and output
  data. Burned counter space is acceptable.

### Mint Operation

Keep `MintOperation` as the durable unit that owns deterministic outputs and proof recovery.
Do not copy the melt operation lifecycle here: melt has a durable `prepared` state because input
proofs are reserved before execution. Mint operations do not reserve existing proofs during prepare,
so the existing mint lifecycle should stay `init -> pending -> executing -> finalized | failed`.

For reusable quotes, the operation should represent:

- the selected withdrawal amount
- the shared quote ID
- the serialized output data for that withdrawal
- the operation state: `init -> pending -> executing -> finalized | failed`

In the decoupled quote saga, `prepare` consumes an existing quote for both mint and melt operations.
For onchain minting, the quote must already exist as a canonical quote record before a withdrawal
operation is prepared.

Preparing a mint operation should not require sufficient remote funding. A successful `prepare()`
transitions the operation from `init` to `pending` after the amount, full quote identity, and
deterministic output data are persisted. `pending` means the operation is recoverable and ready to
redeem once the quote has enough mintable balance; it does not mean payment has already been
observed. Finalization is the step that redeems the quote and issues proofs once the quote can cover
the operation amount.

For reusable quotes, quote observations drive quote-level claiming. When a websocket notification,
polling result, or explicit refresh updates the canonical quote record, the quote processor should
compute the quote's currently claimable balance and try to drain it.

The base branch has replaced operation-shaped quote-state notifications with the
quote-level `mint-quote:updated` event. Quote claiming must also work when no operation exists yet,
because auto-claim may create the first operation for a funded quote. Use the quote-level event or
an equivalent service call as the claim trigger:

```text
mint-quote:updated { mintUrl, method, quoteId, quote }
```

The quote-level event is emitted only after the canonical quote row has been updated. Operation
events such as `mint-op:pending`, `mint-op:executing`, and `mint-op:finalized` remain operation-id
based. Do not reintroduce operation-shaped quote-state events for quote-level claim work.

Claimable balance is remote availability minus durable local operations that have already crossed the
claim boundary for the same remote snapshot:

```text
remoteAvailable = quoteData.amountPaid - quoteData.amountIssued
localReserved = sum(executing mint operations for this quote)
claimable = remoteAvailable - localReserved
```

The processor should first load pending operations for `(mintUrl, method, quoteId)`, sort them by
`createdAt` and then `operationId`, and select the ordered prefix whose running sum stays within the
current claimable amount. Selected operations transition to `executing`; unselected operations remain
`pending`. The selected operations must move `pending -> executing` while the quote-level claim lock is
still held. That `executing` state is the local reservation: duplicate observations subtract those
operations from claimable balance until the mint reports an updated `quoteData.amountIssued`.
Ordinary insufficient funding is not an execution failure.

If claimable balance remains after selecting prepared pending operations, and automatic claiming is
enabled for the quote/method, the processor should create one new pending mint operation for the
remaining claimable amount, then transition it to `executing` inside the same quote-level claim lock.
This lets a live watcher drain all currently issuable value even when no caller prepared a withdrawal
operation in advance. If an older manual pending operation does not fit the current balance, the
automatic drain may still claim the remaining balance as a new operation; that is the explicit
behavior of auto-claim mode.

Direct `finalize(operationId)` is an explicit targeted path for reusable quotes. It should enter the
same serialized quote-claim processor, but it may select the requested operation even if older pending
siblings exist. If the targeted operation fits the current canonical `quoteData.amountPaid -
quoteData.amountIssued`, it may transition to `executing`; if it does not fit, it remains `pending`
with a retryable funding result. This skip-ahead behavior is only for direct caller intent, not
automatic quote-update claiming.

The quote-claim processor should not manually advance `quoteData.amountIssued` as the source of truth
after local finalization. A later mint observation should update the canonical quote record, and that
updated snapshot can trigger another claim pass. To avoid duplicate operation creation or duplicate
execution from the same quote snapshot, claiming for a quote should be serialized by
`(mintUrl, method, quoteId)` and should subtract currently `executing` sibling operations before
creating any automatic drain operation. Do not add a local `amountReserved` counter to the canonical
quote row; the operation state is the reservation source of truth.

Because `executing` operations are the only local reservation source, a reusable-quote operation must
not leave `executing` until the canonical quote row has been refreshed or updated with a remote
observation that reflects the redeemed amount in `quoteData.amountIssued`. This keeps duplicate
notifications for the previous remote snapshot from seeing the same balance as claimable again. The
wallet should not invent `amountIssued`; it should use a NUT-30 mint response or quote refresh that
represents the mint's remote accounting.

This means quote creation and operation creation become separate concepts:

- create/import/watch an onchain quote
- prepare a mint operation that targets a specific amount from that quote
- wait for the quote to become sufficiently funded while explicit operations are pending, or let the
  quote processor auto-create a drain operation when claimable balance appears
- execute/finalize selected operations to redeem quote balance into proofs

### Melt Boundary

Do not extend auto-claim semantics to melt operations. A melt operation spends local proofs, may pay an
external invoice/address, and may reserve or consume local value before settlement is known. The
watcher/processor path for melt must therefore only reconcile operations that already exist because
the caller explicitly created and advanced them.

Melt automation boundary:

- `prepared`: never auto-execute; proofs are reserved, but payment was not sent yet.
- `executing`: recover after restart because the mint call may already have happened.
- `pending`: check/finalize if the remote melt is paid; rollback only when the handler can safely
  prove the quote is unpaid or rollbackable.
- terminal states: leave as terminal.

No watcher, quote notification, polling result, or startup recovery pass should create a melt
operation or move a melt operation from `prepared` to `executing` without explicit caller/user action.

## API Shape

Add an onchain reusable quote flow:

```ts
const quote = await manager.quotes.mint.create({
  mintUrl,
  method: 'onchain',
  unit: 'sat',
});

const refreshed = await manager.quotes.mint.refresh({
  mintUrl,
  method: 'onchain',
  quoteId: quote.quoteId,
});

const operation = await manager.ops.mint.prepare({
  mintUrl,
  method: 'onchain',
  quoteId: refreshed.quoteId,
  amount,
});
```

`prepare()` should require `quoteId` for onchain. Quote creation and operation preparation stay
separate so callers can show/watch a deposit address before choosing one or more withdrawal amounts.
`manager.quotes.mint.create()` persists and returns the canonical quote snapshot; it must not create
operation-owned output data. The current BOLT11 quote API takes an amount because BOLT11 quotes are
fixed amount; the onchain API shape must be method-specific so `onchain` quote creation can omit
`amount` and instead create the remote address from `{ unit, pubkey }`.

If the caller only creates/watches an onchain quote and does not prepare an explicit withdrawal, the
watcher plus quote processor may still claim funds automatically once the quote has claimable balance.
That auto-claim path creates the operation-owned output data at claim time and persists a normal mint
operation.

Auto-claim is enabled by default for live mint quote watcher/processor flows. Applications that only
want quote tracking without automatic redemption should disable auto-claim explicitly in watcher or
manager configuration.

## Implementation Phases

### Phase 0: Base Verification

Status: complete.

Purpose: confirm the rebased branch already owns quote/operation separation so onchain work can start
from the current contracts.

Deliverables:

- [x] Canonical mint quote repository APIs require `(mintUrl, method, quoteId)`.
- [x] Canonical melt quote repository APIs require `(mintUrl, method, quoteId)`.
- [x] `manager.quotes.mint` and `manager.quotes.melt` own quote-only public access.
- [x] Mint `prepare()` consumes an existing quote and does not create remote quotes.
- [x] Melt `prepare()` consumes an existing quote and does not create remote quotes.
- [x] History/upsert paths use `operationId` and can represent sibling operations that share a quote.
- [x] Quote observations update canonical quote records before operation processing.
- [x] `mint-quote:updated` is the quote-level trigger and no `mint-op:quote-state-changed` dependency
      remains.

### Phase 1: Typed Quote Model and Persistence

Status: complete.

Purpose: make the canonical mint quote model capable of representing both BOLT11 fixed-amount quotes
and NUT-30 reusable onchain quotes without leaking quote metadata into operation `methodData`.

Deliverables:

- [x] Add method-registry types for quote creation input and persisted quote metadata:
      `createQuoteData` and `quoteData`, separate from operation-scoped `methodData`.
- [x] Refactor `MintQuote` so `amount` and protocol `state` are not universal top-level fields:
      BOLT11 stores fixed amount and protocol state, while onchain stores `pubkey`, `amountPaid`, and
      `amountIssued` in `quoteData`.
- [x] Add `onchain` to the mint method registry, but keep handler execution minimal until later phases.
- [x] Update `QuoteApi` and `QuoteLifecycle` input types so BOLT11 quote creation keeps `{ amount, unit }`
      and onchain quote creation uses `{ unit }`; NUT-20 `pubkey` derivation is implemented in Phase 2.
- [x] Extend every canonical mint quote adapter/store with typed `quoteData` persistence.
- [x] Preserve existing BOLT11 behavior and migrated quote rows through the model refactor.

Validation:

- [x] Core unit tests cover BOLT11 quote create/get/refresh after the model refactor.
- [x] Adapter contract tests cover round-tripping BOLT11 `quoteData.amount` and onchain
      `quoteData.pubkey`/`amountPaid`/`amountIssued`.
- [x] Core and affected adapter typechecks pass.
- [x] Generated `dist/` remains untouched.

### Phase 2: NUT-20 Quote Keys and Onchain Quote Creation

Status: in progress.

Purpose: create NUT-30 mint quotes through `manager.quotes.mint.create()` with one fresh NUT-20 key per
quote and persisted quote-scoped metadata.

Deliverables:

- [x] Add a NUT-20 key purpose to keyring persistence, separate from user-facing/P2PK keys.
- [x] Migrate existing keyring rows to the default user-facing purpose, for example `p2pk`.
- [x] Filter user-facing keyring APIs so `nut20_mint_quote` keys are not returned or removed by generic
      user/P2PK key management flows.
- [x] Derive NUT-20 quote keys from `m/129373'/20'/0'/0'/{index}`.
- [x] Generate and persist exactly one fresh NUT-20 quote key per new onchain quote; do not reuse keys
      across quotes.
- [x] Add the onchain mint quote handler path that sends `{ unit, pubkey }` and persists the returned
      `quote`, `request`, `unit`, `expiry`, `pubkey`, `amount_paid`, and `amount_issued`.
- [x] Refresh onchain quote observations and compute available amount as
      `quoteData.amountPaid - quoteData.amountIssued`.
- [ ] Treat below-`min_amount` UTXOs as unavailable because NUT-30 says they do not increase
      `amount_paid` and must not be aggregated.

Validation:

- [x] Creating two onchain quotes derives two distinct NUT-20 public keys.
- [x] Onchain quote creation persists `pubkey`, `amountPaid`, and `amountIssued`.
- [x] Onchain quote refresh updates canonical `quoteData` before emitting/calling quote-level work.
- [x] Generic latest/all/remove keyring APIs do not expose or delete `nut20_mint_quote` keys.

### Phase 3: Explicit Onchain Withdrawal Preparation

Purpose: prepare local mint operations against pre-created onchain quotes while keeping the mint
lifecycle `init -> pending -> executing -> finalized | failed`.

Deliverables:

- [x] Extend the existing pre-created-quote mint prepare path so onchain accepts an explicit withdrawal
      amount with `quoteId`.
- [x] Preserve quote-ID-required preparation; do not add `prepare({ amount })` or create-quote wrappers
      back to `manager.ops.mint.prepare()`.
- [x] Validate that the canonical quote row and required NUT-20 signing material are available before
      persisting the operation.
- [x] Do not require sufficient remote quote balance during prepare.
- [x] Create deterministic outputs for the operation during prepare so recovery can redeem later.
- [x] Accept consumed output counters if operation persistence fails; never roll counters back.
- [x] Create deterministic outputs per withdrawal operation, not per quote.
- [ ] Preserve crash recovery for operations that already have output data.

Validation:

- [x] A reusable quote with no available balance can still prepare a pending operation.
- [x] Preparing against an existing onchain quote without required NUT-20 signing material fails before
      persisting the operation.
- [x] If onchain prepare fails before operation persistence commits, no operation is persisted and
      consumed output counters are not rolled back.
- [x] Two mint operations can share one `(mintUrl, method, quoteId)` and both persist independently.

### Phase 4: Quote Claiming and Onchain Mint Execution

Purpose: redeem available onchain quote balance into operation-owned proofs without double-claiming the
same remote snapshot.

Deliverables:

- [ ] Add quote-update claiming for reusable quotes: load pending siblings, sort by `createdAt` then
      `operationId`, and select the ordered prefix whose running sum fits the current claimable balance.
- [ ] Compute local reservation as the sum of `executing` mint operations for the same
      `(mintUrl, method, quoteId)`; do not add `amountReserved` to quote rows.
- [ ] Move selected pending operations to `executing` before releasing the quote-level claim lock.
- [ ] Use quote availability checks as a scheduling/finalization gate, not as a prepare gate.
- [ ] Make direct `finalize(operationId)` enter the same serialized quote-level claim processor, while
      allowing explicit caller intent to target a later sibling if it fits.
- [ ] Keep insufficient reusable quote balance as `pending` or a retryable funding result, not a
      terminal `failed` operation.
- [ ] Execute mint requests with the NUT-20 signature over `quoteId || B_0 || ... || B_n` using the
      quote's persisted key.
- [ ] Before a reusable quote operation leaves `executing`, refresh or update the canonical quote row
      with a NUT-30 quote response whose `amount_issued` reflects the redemption.
- [ ] Support multiple partial withdrawals from the same quote.

Validation:

- [ ] Direct finalization of an underfunded reusable quote leaves the operation pending without entering
      executing.
- [ ] Direct finalization of a funded smaller withdrawal succeeds.
- [ ] Duplicate refresh events for an unchanged quote snapshot do not schedule overlapping execution
      because executing siblings are subtracted.
- [ ] A finalized reusable quote operation is not allowed to stop contributing local reservation before
      the quote row reflects the corresponding remote `quoteData.amountIssued` increase.
- [ ] Recovery can finalize one sibling operation without touching another sibling on the same quote.

### Phase 5: Watchers, Auto-Claim, and Recovery Policy

Purpose: connect quote observations to reusable quote claiming without making watchers perform mint
execution inline or creating melt operations automatically.

Deliverables:

- [ ] Add or widen a quote-centric mint watcher path for canonical quotes without local operations. The
      current BOLT11 watcher is still operation-driven: it starts from `mint-op:pending`, subscribes by
      quote, and maps notifications back to an operation ID.
- [ ] For methods without WebSocket support, rely on polling/explicit refresh.
- [ ] Keep watchers as observation code: they update canonical quote records and emit quote-level claim
      work, but they should not directly create operations or execute mint requests inline.
- [ ] Use the existing quote-level claim trigger,
      `mint-quote:updated { mintUrl, method, quoteId, quote }`, emitted only after the canonical quote
      row is updated.
- [ ] Do not reintroduce operation-shaped quote-state events for quote-level claim work.
- [ ] Process quote-level claim work by full `(mintUrl, method, quoteId)` identity.
- [ ] When automatic claiming is enabled and selected pending operations do not exhaust claimable
      balance, create one new pending auto-claim operation for the remaining claimable amount and move
      it to `executing` inside the same quote-level claim lock.
- [ ] Enable mint auto-claim by default when the mint quote watcher/processor is running, with an
      explicit manager/watcher opt-out.
- [ ] Keep auto-claim processors scoped to mint operations only.
- [ ] Ensure any melt watcher/processor work only reconciles explicit operations already in `executing`
      or `pending`; it must not create melt operations or execute `prepared` melts.

Validation:

- [ ] A funded quote with no existing mint operation can trigger auto-claim through the quote-level
      event/service path.
- [ ] A quote update with remaining claimable balance and no pending operation creates one auto-claim
      operation for the full remaining amount and moves it to `executing`.
- [ ] A quote update with pending operations that only partially consume claimable balance creates one
      auto-claim operation for the remainder.
- [ ] Mint auto-claim events do not create or execute melt operations.
- [ ] A stale `prepared` melt operation is not executed by watcher startup, quote processing, polling,
      or recovery.

### Phase 6: Public API, React, Docs, and Final Validation

Purpose: make the new flow understandable and keep public surfaces aligned with the base branch split.

Deliverables:

- [ ] Expose reusable quote flow from `manager.quotes.mint`, not from `MintOpsApi`.
- [ ] Keep `manager.ops.mint` focused on operation creation, execution, refresh, and finalization.
- [ ] Keep `manager.ops.mint.prepare()` and `manager.ops.melt.prepare()` quote-ID-required entry points;
      examples and docs should show quote creation through `manager.quotes` first.
- [ ] Decide the React hook surface for quote tracking versus operation execution.
- [ ] Decide whether React quote tracking should wrap `manager.quotes` directly or use a dedicated quote
      hook separate from operation hooks.
- [ ] Document that `quoteId` is not a stable local operation identifier.
- [ ] Add examples for onchain quote refresh and partial minting.

Validation:

- [ ] Core typecheck passes.
- [ ] Core unit tests pass.
- [ ] Adapter contract tests pass for affected adapters.
- [ ] React typecheck/lint passes if React surfaces change.
- [ ] Docs build passes if docs change.
- [ ] Generated `dist/` remains untouched.

## Invariants

- `operationId` is the local identity for operations, history rows, event payloads, and hook binding.
- `quoteId` can be shared by multiple local operations.
- Quote identity is always the full `(mintUrl, method, quoteId)` tuple, with `mintUrl` normalized
  before persistence and lookup.
- Quote records are the only canonical source for shared quote metadata.
- Quote-only public access belongs to `manager.quotes.mint` and `manager.quotes.melt`; operation APIs
  stay under `manager.ops`.
- Mint and melt operation preparation require a pre-created canonical quote. `manager.ops` must not
  create remote quotes as a side effect of prepare.
- Method-specific quote metadata lives in `quoteData`; operation-scoped metadata remains in
  `methodData`.
- Onchain mint quotes do not have a protocol state field. Persist `amountPaid` and `amountIssued` from
  NUT-30 and derive readiness/claimability locally.
- NUT-20 quote-signing keys are unique per quote and derived from
  `m/129373'/20'/0'/0'/{index}`.
- NUT-20 private keys remain in keyring storage with `nut20_mint_quote` purpose metadata; existing
  user-facing keys use the default `p2pk` purpose; quote records store the public key reference.
- User-facing keyring APIs must not expose or delete `nut20_mint_quote` keys unless they explicitly
  opt into quote-key management.
- Reusable quote creation persists the NUT-20 key before the remote quote call.
- Onchain `prepare()` expects an existing canonical quote and never creates a remote quote.
- Onchain prepare may burn output counters before persistence; counters are monotonic and are not
  rolled back when in-memory output data is dropped.
- Mint `prepare()` is an API action, not a durable `prepared` state; successful prepare persists
  deterministic output data and moves the operation to `pending`.
- Preparing an operation does not require the quote to be sufficiently funded.
- Pending means awaiting eligible payment or mintable quote balance.
- Finalization is the redemption step that calls the mint endpoint and saves issued proofs.
- Auto-claiming is mint-only. It must never create a melt operation, execute a melt operation, or spend
  local proofs on behalf of a user.
- Melt `prepared` means local proofs are reserved but payment was not sent; no watcher, processor, or
  recovery pass may auto-execute a prepared melt.
- Melt `executing` and `pending` reconciliation is allowed only because an explicit operation already
  crossed the caller-controlled execution boundary.
- Watchers observe quote responses and update canonical quote records; quote processors claim quote
  balance. Watchers should not directly mint or persist auto-claim operations inline.
- Quote-level claim work is triggered by quote identity after canonical quote persistence, not by
  operation-shaped events.
- No `mint-op:quote-state-changed` dependency remains in the core/public event map; reusable quote
  auto-claim uses `mint-quote:updated` or an equivalent quote-level service call because auto-claim
  may need to run before any operation exists.
- Mint auto-claim is enabled by default when the mint quote watcher/processor is running, unless the
  application explicitly opts out.
- Reusable quote updates drive quote-level claiming: pending siblings are sorted by `createdAt` and
  `operationId`, then the ordered prefix whose running sum fits the quote's current claimable balance
  is selected.
- Automatic claiming drains any remaining locally unreserved claimable balance by creating a new mint
  operation for that amount and moving it to `executing` in the quote-claim critical section.
- Claimable balance is the canonical remote mintable amount minus `executing` sibling mint operations
  for the same quote.
- Do not persist a local `amountReserved` counter on the quote row; quote rows track remote quote
  observations, and mint operation state tracks local claim ownership.
- Direct `finalize(operationId)` for reusable quotes is a targeted quote-claim path and may skip older
  pending siblings if the requested operation fits the current canonical claimable amount.
- Reusable quote claiming is serialized per `(mintUrl, method, quoteId)` to avoid duplicate operation
  creation or duplicate scheduling from the same quote snapshot.
- Selected reusable quote operations may transition `pending -> executing`; insufficient mintable
  balance leaves unselected operations `pending`.
- `executing` means a mint redemption call is in progress or being recovered, not that the wallet is
  merely checking whether the quote has enough funds.
- `failed` is reserved for terminal failures such as quote expiry, invalid quote/signature data, mint
  rejection, or unrecoverable issued-without-proofs cases. Insufficient reusable quote funding is
  retryable waiting, not terminal failure.
- A reusable onchain quote's remote mintable amount is `quoteData.amountPaid -
  quoteData.amountIssued`.
- Local finalization does not make `quoteData.amountIssued` canonical; the next websocket, polling, or
  explicit refresh observation updates the quote row and can trigger the next claim pass.
- `executing` sibling operations protect against stale remote snapshots until the mint reports a new
  `quoteData.amountIssued`.
- A reusable quote operation must not transition from `executing` to `finalized` until the canonical
  quote row reflects the mint's updated `quoteData.amountIssued` for that redemption.
- Quote refresh data belongs to the canonical quote record. Operation observation fields should not
  become a second canonical source of truth.
- Output data is owned by one operation and must not be reused across sibling operations.
- A quote refresh must not overwrite sibling operation state.
- Recovery must be able to finish an operation after process restart once output data was persisted.

## Tests to Add

- Two mint operations share one `(mintUrl, method, quoteId)` and both persist independently.
- Onchain quote creation is exposed through `manager.quotes.mint.create()` and does not require an
  amount.
- Onchain quote refresh is exposed through `manager.quotes.mint.refresh()`.
- No `manager.ops.mint.createQuote()` or `manager.ops.mint.refreshQuote()` API is introduced.
- Mint `prepare()` requires `quoteId`; no `prepare({ amount })` compatibility wrapper remains.
- Melt `prepare()` requires `quoteId`; no melt prepare path creates a remote quote.
- BOLT11 quote data persists fixed amount and protocol state without requiring onchain balance fields.
- Onchain quote data persists `pubkey`, `amountPaid`, and `amountIssued` without requiring a protocol
  state field.
- Onchain claimability is derived from `quoteData.amountPaid - quoteData.amountIssued`.
- History lists both sibling operations without overwriting either row.
- `getByQuoteId(mintUrl, method, quoteId)` returns all siblings in deterministic order.
- A reusable quote with no current available balance can still prepare a pending operation.
- A reusable quote with available balance can finalize a smaller withdrawal.
- Creating two onchain quotes derives two distinct NUT-20 public keys.
- Multiple withdrawals from one quote reuse that quote's NUT-20 key and do not derive new keys.
- Existing keyring rows are migrated to the default user-facing key purpose.
- Generic latest/all/remove keyring APIs do not return or delete `nut20_mint_quote` keys.
- Onchain mint execution signs the exact operation output set with the quote key.
- Missing NUT-20 private key for a persisted quote is surfaced as unrecoverable key material, not as
  insufficient quote funding.
- Mint and melt `prepare()` without `quoteId` fail instead of creating a remote quote.
- If onchain prepare fails before operation persistence commits, no operation is persisted and
  consumed output counters are not rolled back.
- Preparing against an existing onchain quote without required NUT-20 signing material fails before
  persisting the operation.
- Direct finalization of an underfunded reusable quote leaves the operation pending without entering
  executing.
- Quote refresh updates the canonical quote record before quote-claim processing starts.
- Quote refresh emits or calls a quote-level claim trigger by `(mintUrl, method, quoteId)` after
  canonical quote persistence.
- No package emits or listens to `mint-op:quote-state-changed` for quote-only updates.
- Quote claiming selects the ordered prefix of pending siblings by `createdAt` then `operationId`
  until the current claimable amount is filled.
- A quote update with remaining claimable balance and no pending operation creates one auto-claim
  operation for the full remaining amount and moves it to `executing`.
- A quote update with pending operations that only partially consume claimable balance creates one
  auto-claim operation for the remainder.
- Repeated watcher/polling/manual refresh events for an unchanged quote snapshot do not create
  duplicate auto-claim operations because executing sibling operations are subtracted.
- The canonical quote row does not need an `amountReserved` field; duplicate prevention comes from
  summing executing operations for the quote.
- A finalized reusable quote operation is not allowed to stop contributing local reservation before the
  quote row reflects the corresponding remote `quoteData.amountIssued` increase.
- An older manual pending operation that does not fit can remain pending while auto-claim drains the
  currently claimable smaller balance.
- Direct finalization of a later reusable quote operation can skip older pending siblings when the
  targeted operation fits the current canonical claimable amount.
- Direct finalization of a targeted reusable quote operation that does not fit keeps it pending and
  returns a retryable funding result.
- Duplicate watcher/polling/manual refresh events for the same reusable quote cannot schedule
  overlapping execution batches from the same quote snapshot.
- BOLT11 paid quote notifications still result in automatic full-amount claiming/finalization when the
  watcher/processor is live.
- Mint auto-claim is enabled by default and can be disabled through explicit watcher/manager config.
- A funded quote with no existing mint operation can still trigger auto-claim through the quote-level
  event/service path.
- Mint auto-claim events do not create or execute melt operations.
- A stale `prepared` melt operation is not executed by watcher startup, quote processing, polling, or
  recovery.
- Melt `pending` reconciliation can finalize or safely rollback an existing explicit melt, but cannot
  create a replacement melt or execute another prepared melt.
- Finalizing a withdrawal above available balance keeps the operation pending and returns a
  retryable funding result before consuming outputs.
- Recovery can finalize one sibling operation without touching another sibling on the same quote.
