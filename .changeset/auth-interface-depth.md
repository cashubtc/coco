---
'@cashu/coco-core': major
---

Replace the exported `AuthApi` forwarding class with a structural type implemented directly by the session's existing authentication module. `manager.auth` keeps its eight methods, parameters, results, and authentication behavior.

The runtime `AuthApi` constructor and prototype are removed. Import `AuthApi` with `import type`, use `manager.auth` instead of `new AuthApi(...)`, and implement the interface instead of subclassing the removed class.
