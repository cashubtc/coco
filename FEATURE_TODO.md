# Mint Quote Removal Plan

## Goals

- Make mint operations the single durable source of truth for quote-backed mint flows.
- Remove the legacy mint-quote service, watcher, processor, and API surface.
- Keep the legacy mint quote repository temporarily only as a compatibility / reconciliation source during migration.
- Move all mint quote metadata needed for execution, recovery, history, and subscriptions into mint operations.
- Preserve crash-safe recovery, background processing, and adapter portability across sqlite3, sqlite-bun, expo-sqlite, indexeddb, and memory repositories.

## Constraints

- Existing persisted `MintQuote` rows may exist without matching mint operations.
- Creating a missing prepared mint operation from a legacy quote row requires runtime services such as wallet access, counters, seed-derived outputs, and the normal operation lifecycle; this cannot be handled by schema migration alone.
- Existing public APIs and events are still used throughout tests, docs, and likely downstream integrations.
- History currently depends on quote payload data such as `request`, `amount`, `unit`, and `state`.
- Watcher and processor startup currently depend on quote repository scans and quote events.
- Mint-operation persistence is still unreleased, so mint-operation schema changes should update the existing adapter schema definitions in place rather than adding new mint-operation migrations/version bumps.

## Target End State

- `MintOperation` persists both:
  - operation lifecycle state: `init`, `pending`, `executing`, `finalized`, `failed`
  - init-time local intent for new-quote and import flows, even before a remote quote exists; this init payload includes at least `method`, `unit`, and `amount`
  - quote snapshot / quote tracking data on prepared and later quote-backed states: `amount`, `request`, `unit`, `expiry`, optional `pubkey`, `lastObservedRemoteState`, optional `lastObservedRemoteStateAt`, and any terminal failure metadata needed for recovery and processors
  - method-owned remote observation metadata:
    - each mint method defines its own remote-state union
    - handlers translate method-specific remote states into normalized service categories such as waiting / ready / completed / terminal
- `manager.ops.mint` owns the full mint quote lifecycle:
  - expose a one-call API for preparing a new mint quote-backed operation, while internally keeping `MintOperationService.init()` -> `MintOperationService.prepare()`
  - expose a one-call API for importing an existing mint quote as a prepared pending operation, while internally keeping `init` as the first durable state
  - redeem / finalize / recover
  - list / inspect tracked mint quote operations
- Watching and processing PAID / ISSUED quote transitions operate on mint operations, not on `MintQuoteRepository`.
- History is created and updated from mint operations plus observed quote-state updates emitted from the operation-based watcher path.
- Legacy `mint-quote:*` events are fully replaced by operation-based mint events rather than kept as a long-term compatibility layer.
- During the transition, a legacy `MintQuoteRepository` may still exist as a startup reconciliation source for old persisted quote rows that do not yet have operations.
- Legacy quote APIs are removed after migration and compatibility coverage are in place.

## Proposed Phases

### Phase 1: Expand the mint operation model

- Scope note: this phase is limited to mint-operation types, persisted schema/repository shape, and adapter coverage. Service/API orchestration changes for quote-less `init`, remote quote creation during `prepare`, and watcher/processor-driven state refresh land in later phases.
- Extend `MintOperation` types to include quote snapshot data needed for execution, recovery, history, and watching.
- Persist the latest observed remote quote state as diagnostic / history metadata on the operation, without making it the authoritative lifecycle state.
- Add structured terminal failure metadata so quote-oriented flows do not rely on parsing error strings.
- Update all mint operation repositories and schemas to persist the expanded shape, altering the existing unreleased mint-operation schema definitions in place rather than adding new adapter migrations for these fields.
- Keep the old quote repository temporarily while operation persistence and startup reconciliation are being introduced.

### Phase 2: Move creation/import into `ops.mint`

- Add operation-oriented APIs for:
  - preparing a new mint quote-backed operation in one API call
  - importing an existing mint quote into a prepared pending operation in one API call
  - listing tracked mint quote operations
- Make `MintOperationService` own quote creation/import bookkeeping.
- Keep the internal lifecycle explicit:
  - `init` remains the first durable local operation state
  - for brand-new quotes, `init` may exist before any `quoteId` or remote quote snapshot has been created
  - `init` persists local mint intent such as `method`, `unit`, and `amount`, while `quoteId` is added during `prepare`
  - API-level prepare/import calls may compose multiple service steps, but they should still persist an `init` operation before transitioning to `pending`
  - for brand-new quotes, follow the melt-style sequencing:
    - persist an `init` operation first
    - create the remote mint quote during `prepare`
    - generate deterministic output data during the same `prepare` step
    - persist the fully prepared `pending` operation with the quote snapshot only after the quote and local prepared data are both available
  - for imported existing quotes, `init` should already contain enough local intent to transition into `pending` using the imported quote snapshot
  - `prepare` remains the transition that materializes deterministic output data and persists the fully prepared `pending` operation
- Ensure operation creation / import emits the events needed by watchers and history.

### Phase 2.5: Add legacy quote reconciliation at runtime

- Keep `MintQuoteRepository` as a temporary legacy persistence source after `MintQuoteService` is no longer the primary orchestration layer.
- Add a startup reconciliation step that scans legacy stored mint quotes and ensures each relevant quote has a corresponding mint operation.
- If a legacy stored quote has no matching mint operation:
  - create the operation through the normal operation lifecycle
  - preserve the internal durable `init -> prepare -> pending` progression
  - materialize deterministic outputs at runtime using the normal services rather than via schema migration code
- Make reconciliation idempotent by checking for existing operations by `(mintUrl, quoteId)` before creating anything.
- Treat stale quote-backed `init` operations as incomplete reconciliation work, not as a completed backfill result:
  - if a quote has a matching `pending`, `executing`, `finalized`, or `failed` operation, do not create another one
  - if a quote only has a matching `init` operation, startup reconciliation must resume that operation through `prepare` instead of skipping it
  - do not rely on generic init-cleanup recovery to delete backfilled quote-backed `init` operations before reconciliation has a chance to resume them
- Run reconciliation before watcher startup, processor startup, and mint-operation recovery so the rest of the system sees a consistent operation-first view.

### Phase 3: Rewire watcher and processor around operations

Implementation order for this phase:

1. Rewire watcher startup and live subscription registration around pending mint operations while keeping legacy quote-state compatibility events flowing from the operation path.
2. Rewire processor queueing and execution around mint operations / operation lookup instead of quote-repository-driven orchestration.
3. Rewrite history creation and state updates to consume operation-owned quote snapshots and operation-based mint events.
4. Remove the remaining quote-repository-driven watcher / processor assumptions once the operation path fully owns background mint flow progression.

- Replace quote-repository scans with mint-operation scans.
- Replace the legacy quote-repository-driven watcher with an operation-based watcher.
- Replace quote events as the primary trigger path with mint-operation events plus remote quote-state updates from the operation-based watcher.
- Treat imported and newly created unpaid mint quotes as fully prepared `pending` mint operations with all deterministic local data already materialized.
- Split responsibilities explicitly:
  - watcher observes remote quote changes, updates observational metadata, and emits quote-state change events for history / processor triggers
  - processor is the only background component that advances local operations from `pending` into `executing`
  - recovery is responsible for reconciling `executing` operations back to `pending`, `finalized`, or `failed`
- Ensure startup behavior still covers:
  - pending unpaid quotes that need watching
  - PAID quotes that need processing
  - executing operations that need recovery
  - finalized / failed operations that should not be requeued
- Ensure subscription resume behavior also covers the same operation-based work classes as startup bootstrap:
  - pending unpaid operations that need watcher coverage again
  - PAID operations that need processor queue coverage again
  - executing operations that need recovery/reconciliation before normal background processing resumes
- Ensure runtime behavior also covers imported quotes without requiring a restart:
  - importing an already-PAID external quote should create a normal `pending` mint operation and enqueue processor work immediately
  - importing an unpaid external quote should create a normal watched `pending` mint operation that will be queued later when the watcher observes `PAID`

### Phase 3.5: Replace `mint-quote:*` events with `mint-op:*`

- Introduce an operation-based mint event model that fully replaces the old quote events.
- Keep `mint-op:pending`, `mint-op:executing`, and terminal lifecycle events as the primary public mint event surface.
- Add a dedicated quote-observation event for watcher output, for example `mint-op:quote-state-changed`, carrying:
  - `mintUrl`
  - `operationId`
  - `quoteId`
  - `previousState`
  - `state`
  - the latest operation snapshot
- Rewire internal consumers in this order:
  - watcher emits operation-based quote observation events
  - processor queues from operation-based events and operation scans
  - history creates and updates entries from operation-based events
- Remove `mint-quote:requeue` entirely once bootstrap logic scans pending mint operations directly.
- Remove `mint-quote:created`, `mint-quote:added`, `mint-quote:state-changed`, and `mint-quote:redeemed` once all internal listeners have been migrated.

### Phase 4: Migrate persisted data

- Do not add new adapter schema migrations solely for unreleased mint-operation field changes; change the existing mint-operation schema definitions in place.
- Handle persisted legacy quote data by:
  - copying quote metadata into existing mint operations when needed
  - preserving enough legacy quote data for runtime reconciliation to create missing mint operations after restart
- Validate restart / reconciliation behavior across all adapters.

### Phase 5: Move history and compatibility layers

- Update history creation and state updates to use mint operations instead of `mint-quote:*` payloads.
- Migrate all internal listeners to `mint-op:*` and remove legacy `mint-quote:*` events rather than keeping a long-term compatibility event layer.
- Update tests, docs, and examples to use `manager.ops.mint`.

### Phase 6: Remove legacy stack

- Remove:
  - `MintQuoteService`
  - `MintQuoteWatcherService`
  - `MintQuoteProcessor`
  - `MintQuoteRepository`
  - legacy mint quote API methods from `QuotesApi` / `Manager`
  - related manager config for mint-quote watcher / processor
- Remove adapter implementations and exports for mint quote repositories.
- Remove quote-specific tests once operation-based replacements exist.

## TODOs

### Model and repository TODOs

- [x] Define the operation-owned quote snapshot shape for mint operations.
- [x] Define the init-time local intent shape for mint operations separately from the pending quote snapshot shape, with `method`, `unit`, and `amount` persisted before any quote exists.
- [x] Allow the persisted mint-operation model to represent `init` operations before a remote quote exists, so later service work is not forced to persist `quoteId`, `request`, or a quote row up front.
- [x] Make `quoteId` absent from persisted `init` mint operations and introduce it during `prepare`, either from an imported quote snapshot or from the newly created remote mint quote.
- [ ] Decide whether `quoteId` becomes optional on one unified persisted mint-operation shape or whether `init` and pending+ states should use separate persisted field requirements.
- [x] Add `lastObservedRemoteState` and `lastObservedRemoteStateAt` to mint operations as observational metadata.
- [x] Make remote observation state method-owned rather than globally quote-owned, so future mint methods can define different remote-state unions.
- [x] Wire `lastObservedRemoteState` / `lastObservedRemoteStateAt` through the watcher / processor / finalize paths so operations persist the latest observed remote state, not just the prepare-time snapshot.
- [x] Define structured terminal failure fields for mint operations.
- [ ] Define the prepared-data invariant for `pending` mint operations so create/import always persist all local execution data up front.
- [ ] Ensure the new prepare flow persists quote snapshot data and deterministic outputs atomically.
- [ ] For brand-new quotes, mirror the melt flow: persist `init`, create the remote quote during `prepare`, then persist the prepared `pending` operation with quote snapshot data.
- [ ] Define the import-time init payload so `prepare` can transition an imported quote-backed `init` operation into a normal quote-backed `pending` operation without consulting `MintQuoteRepository`.
- [x] Update core mint operation types.
- [x] Update memory mint operation repository.
- [x] Update sqlite3 mint operation repository and schema.
- [x] Update sqlite-bun mint operation repository and schema.
- [x] Update expo-sqlite mint operation repository and schema.
- [x] Update indexeddb mint operation repository and schema.
- [x] Add repository round-trip / persisted-shape coverage for the new fields in every adapter, plus migration coverage where applicable.
- [ ] Keep the legacy mint quote repository shape stable enough to support temporary startup reconciliation.

### Service and API TODOs

- [x] Redefine `ops.mint.prepare(...)` as a one-call API that internally performs `MintOperationService.init()` followed by `MintOperationService.prepare()`.
- [x] Add `ops.mint` API support for importing an existing mint quote into a prepared pending operation.
- [x] Keep `MintOperationService.init()` as the first durable local state transition; do not collapse the internal lifecycle into a single persisted step.
- [x] Split the API and service contracts between:
  - new-quote prepare, which should not require a pre-existing `quoteId` and should derive `quoteId` during `prepare`
  - import-existing-quote prepare, which should accept a pre-existing quote snapshot / `quoteId`
- [x] Redefine `MintOperationService.init()` so new-quote init persists only local creation intent, mirroring `MeltOperationService.init()`, instead of validating a pre-existing quote row.
- [x] Redefine `MintOperationService.prepare()` so it performs the melt-style orchestration step:
  - for new quotes, call the handler to create the remote quote during `prepare`
  - for imported quotes, normalize and validate the imported quote snapshot during `prepare`
  - only then derive deterministic outputs and persist the fully prepared `pending` operation with `quoteId` and the full quote snapshot attached
- [x] Refactor `MintBolt11Handler.prepare()` to mirror `MeltBolt11Handler.prepare()` by creating or ingesting the quote snapshot first and returning a complete pending-operation payload.
- [x] Move quote validation that currently happens in mint `init()` into the appropriate create/import `prepare()` path so quote-less init rows remain valid.
- [x] Ensure the prepare path uses the same mint-scoped locking guarantees as melt while creating the quote and materializing deterministic outputs.
- [x] Add any missing operation query APIs needed by watcher / processor / history flows.
- [x] Refactor `MintOperationService` to create and manage quote-backed operations without `MintQuoteRepository`.
- [x] Remove `MintQuoteService` as the primary orchestration path while keeping `MintQuoteRepository` available temporarily for startup reconciliation.
- [x] Refactor `MintBolt11Handler` and mint method deps to consume operation-owned quote data.
- [x] Remove mint quote methods from `QuotesApi` while keeping melt quote methods intact for now.
- [x] Decide whether `manager.quotes` remains as a melt-only API or keeps temporary deprecated mint shims during migration.

### Watcher and processor TODOs

- [x] Define the replacement event model for mint flows:
  - `mint-op:pending` for tracked/prepared quote-backed operations
  - `mint-op:quote-state-changed` for observed remote quote state changes
  - `mint-op:executing`
  - terminal lifecycle events for success and failure
- [x] Add any missing mint-operation events for creation / import if needed.
- [x] Replace the legacy mint quote watcher with an operation-based watcher that subscribes from mint operations.
- [x] Rebuild the mint quote processor to queue from mint operations.
- [x] Remove `MintOperationService.redeem(mintUrl, quoteId)` once the processor no longer delegates quote-id work through the legacy mint-quote service path.
- [x] Rework startup bootstrap to scan mint operations instead of mint quote rows.
- [x] Add a startup reconciliation pass that scans legacy mint quote rows and backfills missing mint operations before watcher / processor / recovery startup.
- [x] Rework `resumeSubscriptions()` to re-establish operation-based watcher / processor / recovery coverage for mint operations, not just restart transports.
- [x] Ensure startup reconciliation resumes quote-backed `init` operations before generic init cleanup can delete them.
- [x] Make the watcher emit operation-based quote observation events instead of `mint-quote:state-changed`.
- [x] Make the processor queue from live operation events:
  - `mint-op:pending` when a newly prepared/imported operation is already observed as `PAID`
  - `mint-op:quote-state-changed` when a watched operation transitions to `PAID`
  - do not rely on pending-operation scans during startup bootstrap; startup backlog should be handled by recovery
- [x] Define whether resume uses the same pending-operation scan/requeue path as startup bootstrap or a smaller resume-specific reconciliation pass, and document the ordering.
- [x] Ensure runtime imports of external quotes are processed without restart:
  - already-PAID imports should enqueue immediately from the operation path
  - unpaid imports should rely on watcher coverage until they transition to `PAID`
- [x] Document and enforce the ownership boundary: watcher observes, processor advances live `pending`, recovery reconciles startup/backlog `pending` plus `executing`.
- [ ] Preserve untrusted-mint behavior for watched / queued work.
- [ ] Preserve expired-quote handling and other terminal processor outcomes.
- [x] Ensure unpaid watched quotes remain in local `pending` state until they eventually converge to `executing`, `finalized`, or `failed`.
- [x] Persist only the latest observed remote state as metadata; do not treat it as the authoritative operation state.
- [ ] Define when watcher callbacks update `lastObservedRemoteState` and when action paths must still re-check remote state before acting.

### Migration TODOs

- [ ] Identify all persisted states that can exist in `MintQuoteRepository` today.
- [ ] Define how orphaned stored `UNPAID` and `PAID` quotes map to new `pending` mint operations.
- [ ] Ensure legacy `ISSUED` quote rows are ignored during migration and never recreated as mint operations.
- [ ] Define the runtime reconciliation algorithm that turns orphan legacy quote rows into mint operations through the normal service lifecycle.
- [ ] Define how reconciliation handles pre-existing `init` operations for the same `(mintUrl, quoteId)` so crashes between `init` and `prepare` remain recoverable.
- [ ] Define how reconciliation distinguishes quote-less create-path `init` operations from imported/reconciled quote-backed `init` operations so recovery does not delete valid in-progress work.
- [ ] Write adapter restart/reconciliation tests for quote-to-operation migration.
- [ ] Verify reconciliation behavior on restart paths, not just fresh databases.
- [ ] Define the import path for external mint quotes so imported rows become normal tracked mint operations immediately.
- [ ] Define the new-quote prepare path so newly created quotes become normal tracked `pending` operations immediately via the melt-style sequence: persisted `init` first, remote quote creation during `prepare`, then persisted `pending`.

### History and events TODOs

- [x] Rewrite mint history creation to use operation-owned quote snapshot payloads.
- [x] Rewrite mint history state updates to use operation-owned quote metadata plus observed quote-state updates from the watcher path.
- [x] Make history creation come from operation events such as `mint-op:pending` rather than `mint-quote:created` / `mint-quote:added`.
- [ ] Make history state updates come from operation events such as `mint-op:quote-state-changed`, `mint-op:finalized`, and terminal failure events.
- [x] Audit all `mint-quote:*` listeners and replace or remove them.
- [x] Remove legacy `mint-quote:*` event types once all internal listeners have been migrated.
- [ ] Update README and API docs to document the new event / API model.

### Removal TODOs

- [ ] Remove `MintQuoteService` from manager wiring.
- [x] Remove the legacy `MintQuoteWatcherService` from manager wiring and config after the operation-based watcher replacement is in place.
- [x] Remove `MintQuoteProcessor` from manager wiring and config.
- [ ] Remove `MintQuoteRepository` from repository interfaces after startup reconciliation and compatibility imports are no longer needed.
- [ ] Remove memory mint quote repository after startup reconciliation and compatibility imports are no longer needed.
- [ ] Remove sqlite3 mint quote repository and schema after startup reconciliation and compatibility imports are no longer needed.
- [ ] Remove sqlite-bun mint quote repository and schema after startup reconciliation and compatibility imports are no longer needed.
- [ ] Remove expo-sqlite mint quote repository and schema after startup reconciliation and compatibility imports are no longer needed.
- [ ] Remove indexeddb mint quote repository and schema after startup reconciliation and compatibility imports are no longer needed.
- [ ] Remove quote API docs and old examples.

### Test coverage TODOs

- [ ] Update unit tests for manager wiring, ops API, history, watcher, and processor.
- [ ] Replace quote-oriented integration tests with operation-oriented equivalents.
- [ ] Keep migration tests for old persisted quote data.
- [ ] Verify pause / resume and startup recovery behavior.
- [ ] Verify `resumeSubscriptions()` re-establishes watcher, processor, and recovery coverage for operation-based mint flows.
- [ ] Verify background processing of PAID quotes still works after restart.

## Decisions

- Remove the mint-quote portion of `QuotesApi`; melt quote APIs remain for now.
- Mint history remains user-facing quote history with the same shape and semantics.
- Watching an unpaid mint quote continues to use local `pending` state, not `init`.
- Local operation state remains authoritative, but each mint operation should also persist the latest observed remote quote state as non-authoritative metadata.
- External mint quotes must be importable, and once imported they should be represented as normal `pending` mint operations.
- `manager.ops.mint` may expose one-call prepare/import APIs, but the internal service lifecycle should continue to use an explicit durable `init -> prepare -> pending` progression.
- Brand-new mint-operation `init` rows are quote-less and persist local creation intent such as `method`, `unit`, and `amount`; `quoteId` and the quote snapshot become mandatory once the operation reaches prepared `pending`.
- Mint-operation persistence is unreleased, so adapter schema changes for this work should update the existing mint-operation schema definitions in place rather than adding extra mint-operation migrations/version bumps.
- `MintQuoteService` should be removed before `MintQuoteRepository`; the repository remains temporarily as a legacy persistence source for startup reconciliation and compatibility imports.
- New quote creation should mirror the melt flow: persist `init` first, create the remote quote during `prepare`, then persist the prepared `pending` operation containing the quote snapshot and deterministic local execution data.
- Replace `mint-quote:*` events completely with operation-based mint events; do not keep a long-term compatibility event layer inside the repo.

## Migration Matrix

### Stored mint quote state -> migrated mint operation

- `UNPAID` quote with no existing mint operation:
  - At runtime startup reconciliation, create a fully prepared `pending` mint operation through the normal service lifecycle.
  - Persist quote snapshot data plus all local deterministic execution data needed later.
  - Start watcher coverage after reconciliation / startup.

- `PAID` quote with no existing mint operation:
  - At runtime startup reconciliation, create a fully prepared `pending` mint operation through the normal service lifecycle.
  - Persist quote snapshot data plus all local deterministic execution data needed later.
  - Processor / startup recovery should be able to advance it toward redemption.

- `ISSUED` quote with no existing mint operation:
  - Do not migrate it into any mint operation.
  - Treat it as legacy data that can be dropped once migration completes.
  - Rely on existing history entries for user-visible recordkeeping.
  - Never allow restart logic to attempt fresh redemption for these rows.

### Existing mint operation + stored mint quote

- Existing `init` / `pending` / `executing` mint operation:
  - Copy quote snapshot data onto the operation.
  - Preserve the operation lifecycle state.
  - Do not overwrite local execution data already stored on the operation.
  - If the existing operation is a quote-backed `init` at startup reconciliation time, resume it through `prepare` rather than treating it as already reconciled.

- Existing `finalized` mint operation:
  - Copy any missing quote snapshot data needed for history / compatibility only.
  - Preserve `finalized`.

- Existing `failed` mint operation:
  - Copy any missing quote snapshot data needed for history / compatibility only.
  - Preserve `failed`.
