---
'@cashu/coco-core': minor
---

prepare accepts optional caller-supplied operation ID with duplicate-join semantics

`SendOpsApi.prepare()` now accepts an optional `operationId`, which becomes the persisted Send
operation identity instead of a generated sub-ID. Embedding hosts that keep their own durable
command records can pass their command ID so one command maps to exactly one operation:

- a repeat with the same intent (mint, amount, unit, method, and method data) returns the existing
  operation instead of preparing a second one, including after a process restart;
- a repeat with a different intent throws the new typed `SendOperationIntentConflictError`;
- a repeat for an ID that has already progressed past `prepared` throws
  `SendOperationConflictError`;
- concurrent prepares that reuse the same ID wait for the in-flight prepare and join its result.

The ID is used verbatim and must be a non-empty string without surrounding whitespace. Omitting
`operationId` keeps the previous generated-ID behavior unchanged.
