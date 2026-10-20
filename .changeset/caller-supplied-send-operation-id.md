---
'@cashu/coco-core': minor
---

prepare accepts a caller-supplied Send operation ID

`SendOpsApi.prepare()` now accepts an optional `operationId` host command ID. Coco stores it
prefixed as `send:<id>`, which keeps it distinct from generated operation IDs and from the
`usedByOperationId` / `createdByOperationId` proof columns used by other operation domains, so one
host command maps to exactly one Send operation across restarts.

The ID must be a non-empty string without surrounding whitespace and without the reserved `send:`
prefix; otherwise `InvalidOperationIdError` is thrown. Omitting `operationId` keeps the previous
generated-ID behavior unchanged.
