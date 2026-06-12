---
'@cashu/coco-core': major
'@cashu/coco-react': major
'@cashu/coco-adapter-tests': patch
---

Refactor melt operation prepare to accept `{ quote }` for BOLT quotes and `{ quote, feeIndex }` for onchain quotes, deriving method data from stored canonical melt quote state.
