---
'@cashu/coco-core': major
'@cashu/coco-react': patch
'@cashu/coco-adapter-tests': patch
'@cashu/coco-indexeddb': patch
'@cashu/coco-sqlite': patch
'@cashu/coco-sqlite-bun': patch
'@cashu/coco-expo-sqlite': patch
---

Split app-facing Mint Operations from adapter-facing durable records.

Public Mint Operation APIs, events, history inputs, and React hooks now expose an explicit safe
projection without deterministic outputs, issuance-attempt references, or future orchestration and
recovery fields. Adapter repositories retain output data and an optional issuance-attempt
reference.
