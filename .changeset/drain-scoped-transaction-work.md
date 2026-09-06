---
'@cashu/coco-core': patch
---

Keep concurrent scoped commands and repository calls inside their owning transaction. A failed
command now rejects further scoped work, drains calls already executing before rollback or retry,
and prevents later calls through an ended scope. The runner enforces this for every module without
requiring callers to replace `Promise.all()` or manually drain sibling promises.
