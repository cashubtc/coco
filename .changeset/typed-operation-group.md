---
'@cashu/coco-core': major
---

Replace the constructor-only `OpsApi` class with a type-only interface and a plain object
under `manager.ops`. Its send, receive, mint, and melt operation interfaces are unchanged.

Import `OpsApi` with `import type` and replace `new OpsApi(send, receive, mint, melt)` with
`const ops: OpsApi = { send, receive, mint, melt }`. Runtime imports, subclassing, and
`instanceof OpsApi` are no longer supported; use `manager.ops` or structural typing instead.
