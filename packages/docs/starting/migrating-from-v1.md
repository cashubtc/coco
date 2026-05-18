# Migrating from v1

This release changes history from a separately written history table into an
operation-first projection.

Operations are now the canonical source of wallet activity. History reads are
derived from send, melt, mint, and receive operation repositories, with older
`coco_cashu_history` rows retained as read-only compatibility entries.

## History entry identity

Operation-backed history entries now use deterministic ids:

- `send:<operationId>`
- `melt:<operationId>`
- `mint:<operationId>`
- `receive:<operationId>`

Legacy rows from the old history table use `legacy:<oldHistoryId>`.

If your app stores history entry ids, treat ids from the previous history table
as legacy ids. New operation-backed entries should be linked by `operationId`.

## Entry source

Every history entry includes `source`:

- `source: 'operation'` for entries projected from operation repositories
- `source: 'legacy'` for read-only fallback entries from old history rows

Operation-backed entries always have `operationId`. Legacy entries may not.

## State values

Operation-backed history uses operation state names:

- Send rollback is now `rolled_back`, not `rolledBack`.
- Receive rollback is now `rolled_back`, not `rolledBack`.
- Mint history uses mint operation states such as `pending`, `executing`,
  `finalized`, and `failed`.
- Melt history uses melt operation states such as `prepared`, `pending`,
  `finalized`, and `rolled_back`.

Legacy entries preserve the old stored state strings, including protocol quote
states such as `UNPAID`, `PENDING`, `PAID`, and `ISSUED`.

## Ordering and freshness

History entries now expose both `createdAt` and `updatedAt`.

Pagination is ordered by `createdAt DESC, id DESC`. Use `updatedAt` for
replacement, freshness, and realtime reconciliation, not for primary ordering.

## Legacy fallback rows

The old `coco_cashu_history` table or store remains readable. New operation
events no longer write to it.

Legacy rows are hidden when an operation-backed entry represents the same
activity:

- rows with `operationId` are hidden behind the same `type + operationId`
- mint and melt rows without `operationId` are hidden behind the same
  `type + mintUrl + quoteId`

Remaining legacy rows are best-effort display data and should not be treated as
operation lifecycle state.

## Realtime updates

`history:updated` still exists, but it now carries the operation-backed
projection for the changed operation. Consumers can update optimistically from
the payload, but repository reads remain authoritative.

History ignores `receive-op:prepared`. Receive entries are projected only for
`finalized` and `rolled_back` states.
