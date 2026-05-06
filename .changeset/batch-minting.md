---
'@cashu/coco-core': minor
'@cashu/coco-indexeddb': minor
'@cashu/coco-expo-sqlite': minor
'@cashu/coco-sqlite': minor
'@cashu/coco-sqlite-bun': minor
'@cashu/coco-adapter-tests': minor
---

Add optimized BOLT11 batch mint finalization for mints that advertise NUT-29 support.

Mint quote preparation no longer precomputes output data. Single quote finalization now persists
its output data immediately before minting, while eligible paid quotes can be finalized together
with consolidated output denominations. Adapters persist batch attempt records and proof batch
metadata so requesting-state crashes can recover the issued outputs.
