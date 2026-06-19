---
'@cashu/coco-core': major
---

Refactor payment method types around built-in and generic method APIs.

Built-in mint and melt methods now use explicit `BuiltIn*Method` names, generic quote creation uses dedicated `createGeneric` APIs, and built-in method names are rejected before generic handler routing.
