---
'@cashu/coco-core': major
'@cashu/coco-react': major
'@cashu/coco-indexeddb': major
'@cashu/coco-expo-sqlite': major
'@cashu/coco-sqlite': major
'@cashu/coco-sqlite-bun': major
'@cashu/coco-adapter-tests': major
---

Migrate Coco to `@cashu/cashu-ts` v4 and native `Amount` semantics.

Public APIs now accept `AmountLike` inputs where callers provide monetary values
and return upstream `Amount` instances for balances, operation amounts, fees,
history entries, and proofs. Persistent adapters store amount columns as
canonical decimal strings and include migrations that preserve old numeric rows.
Operation method metadata serializes BigInt values as decimal strings so
AmountLike method fields remain persistable across adapters, while known amount
metadata is rehydrated as upstream `Amount` values on operation reads.

Packages that depend on `cashu-ts` are now ESM-only. CommonJS export entries and
CJS build outputs were removed, and token encoding now follows the v4 cashu-ts
API without explicit token-version selection.
