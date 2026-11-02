---
'@cashu/coco-core': major
'@cashu/coco-adapter-tests': minor
'@cashu/coco-sql-storage': minor
'@cashu/coco-sqlite': minor
'@cashu/coco-sqlite-bun': minor
'@cashu/coco-expo-sqlite': minor
'@cashu/coco-indexeddb': minor
---

Add Batch Mint Operations: `ops.mint.batch.execute({ mintUrl, method, members })` claims two or more BOLT11, BOLT12 or on-chain quotes from one trusted mint in one atomic NUT-29 request with one aggregate output set, plus `get`, `listByQuote`, `listInFlight` and `recovery.run()`. Admission failures reject with `BatchMintAdmissionError` (or `UnknownMintError`, `MintQuoteKeyError`, `MintSwapChildOperationError`) before anything is persisted, and a batch never falls back to standalone Mint Operations. A method the mint does not advertise for NUT-29, or advertises with a malformed or single-quote `max_batch_size`, rejects with reason `unsupported_method`. A definitive mint rejection marks the batch `failed` and releases its quotes; ambiguous outcomes return it `executing`. Recovery (saved proofs, NUT-09 Restore, then a fresh quote check of exactly the members before replaying the exact request) runs at startup with Mint recovery and through `recovery.run()`. The quote check uses one single-quote check per member and records Quote Observations before acting.

Each Batch Mint Member appears as an ordinary `type: 'mint'` history entry with its own `quoteId`, `paymentRequest` and `amount`, the batch's state, `operationId` and the new `batchMintOperationId` set to the batch ID, and the entry ID `batch-mint:<batchId>:<ordinal>`. Batches publish the new `batch-mint-op:executing | finalized | failed` events with their ordered members and no `mint-op:*` events, so integrators that track quotes through `mint-op:*` events should also listen for `batch-mint-op:*`; automatic claiming also settles the quotes it batches through these events. Mint Swap creation now rejects a destination quote held by an executing Batch Mint Operation, and automatic BOLT11 claiming skips quotes a batch reserves.

Migration notes (breaking):

- `MintOpsApi` takes a new required second constructor argument, `batch: BatchMintOpsApi`, exposed as `ops.mint.batch`. Code that constructs `MintOpsApi` directly must pass it; `Manager` does this for you.
- Quotes claimed through a Batch Mint Operation settle through `batch-mint-op:*` events, not `mint-op:*`, and have no Mint Operation. Their history entries use the per-member ID `batch-mint:<batchId>:<ordinal>` rather than a Mint Operation's ID. Find a quote's claim with `ops.mint.batch.listByQuote({ mintUrl, quoteId })` as well as `ops.mint.listByQuote`.

Adapter migration notes (repository compatibility policy):

- `HistoryProjectionRepository` must project Batch Mint Members: one `type: 'mint'` entry per member with `id` from `batchMintHistoryId(operationId, ordinal)`, `operationId` and `batchMintOperationId` set to the batch ID, the member's `quoteId`, payment request and amount, the batch's `state`, `createdAt`, `updatedAt` and `error`, ordered with other entries by `compareHistoryEntries`. Members also deduplicate legacy mint history rows for their quote.
- `parseHistoryEntryId` now returns `{ source: 'batch-mint', operationId, ordinal }` for member entry IDs; `getHistoryEntryById` must resolve them. `projectBatchMintOperation` and `batchMintHistoryId` are exported from `@cashu/coco-core/adapter`.
- Validate custom adapters with `runBatchMintHistoryContract` from `@cashu/coco-adapter-tests`. The supplied SQL storage and IndexedDB adapters project members from their existing Batch Mint tables and stores; there is no new migration.
