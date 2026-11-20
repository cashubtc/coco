---
'@cashu/coco-core': major
'@cashu/coco-react': minor
'@cashu/coco-adapter-tests': minor
'@cashu/coco-sql-storage': patch
'@cashu/coco-indexeddb': patch
'@cashu/coco-sqlite': patch
'@cashu/coco-sqlite-bun': patch
'@cashu/coco-expo-sqlite': patch
---

Expose Mint Swap as one grouped history action and add its React operation hook. `HistoryType` and
`HistoryEntry` now include `type: 'mint-swap'`, so exhaustive consumers must add that case.

Repository signatures and persisted operation rows are unchanged. Custom history projections must
group the parent and its exact children before pagination while preserving direct child lookup. No
supplied adapter needs a schema or Wallet-data migration.
