---
'@cashu/coco-core': major
---

Claim automatically claimed Mint Quotes through Batch Mint Operations. The startup sweep and the Mint Operation Processor, over one processing turn (`processIntervalMs`) of quote updates, group claimable quotes by mint, method and unit and claim each chunk of two or more within the mint's NUT-29 batch limit as one Batch Mint Operation; reusable quotes claim their full available amount. A lone quote, a method the mint does not advertise for NUT-29, a quote with a nonterminal Mint Operation and a quote coordinated by an active Mint Swap keep a standalone Mint Operation. After a batch is rejected or fails, its still-claimable quotes are claimed as new standalone Mint Operations with fresh outputs. An unsupported batch endpoint, a malformed response or `11017` (batch too large) switches automatic claiming to standalone Mint Operations for that mint and method for the rest of the Coco Session; network, authentication, rate-limit and server failures do not, and the NUT-29 quote-check marker is unaffected. An unsupported endpoint or malformed response stays ambiguous, so that batch keeps its quotes reserved until recovery resolves it.

The new processor option `processors.mintOperationProcessor.batchMintQuotes` (also accepted by `enableMintOperationProcessor`) defaults to `true`; `false` restores one standalone Mint Operation per quote, and `ops.mint.batch` stays available. With batching on, claims from quote updates wait for the end of the processing turn instead of starting immediately.

Migration notes (breaking, because batching is on by default):

- Automatically claimed quotes may now settle through `batch-mint-op:executing | finalized | failed` events instead of `mint-op:*` events, and without a Mint Operation. Listeners that track paid quotes through `mint-op:*` should also listen for `batch-mint-op:*`.
- Their history entries are per-member entries with `batchMintOperationId` set and the entry ID `batch-mint:<batchId>:<ordinal>`, not a Mint Operation's ID. Code that stores or parses history entry IDs must accept them (`parseHistoryEntryId` from `@cashu/coco-core/adapter` returns `{ source: 'batch-mint', operationId, ordinal }`).
- Find a quote's claim with `ops.mint.batch.listByQuote({ mintUrl, quoteId })` as well as `ops.mint.listByQuote`.
- `MintOpsApi` takes a new required `batch` constructor argument (see the Batch Mint Operations changeset).
- Set `processors.mintOperationProcessor.batchMintQuotes: false` (or pass `batchMintQuotes: false` to `enableMintOperationProcessor`) to restore one standalone Mint Operation and `mint-op:*` events per automatically claimed quote.
