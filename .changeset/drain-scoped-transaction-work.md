---
'@cashu/coco-core': patch
---

Keep concurrent scoped commands and repository calls inside their owning transaction. A failed
command now rejects further scoped work, drains calls already executing before rollback or retry,
and prevents later calls through an ended scope. The runner enforces this for every module;
independent operations can use `Promise.all()` without manually draining sibling promises.

Preserve repository bindings exposed through inherited properties or class getters when binding a
transaction scope, including the original receiver for getters.

Remove the scoped allocation queue. Within one transaction, implementations await dependent
mutations sequentially and only parallelize independent work. Concurrent standalone allocations
remain isolated by their separate transactions.
