---
'@cashu/coco-core': patch
'@cashu/coco-adapter-tests': patch
---

Settle incoming payment requests in the same wallet transaction that saves the received proofs. Direct Receive commands and restart recovery also finalize or reject the linked attempt. Recovery repairs unfinished requests from older wallets without crediting the payment twice.
