---
'@cashu/coco-sqlite': patch
'@cashu/coco-sqlite-bun': patch
'@cashu/coco-expo-sqlite': patch
'@cashu/coco-indexeddb': patch
---

Fail fast instead of silently corrupting operation data when hydrating prepared send, receive, and melt operations. Repository adapters previously defaulted missing (NULL) financial fields such as amounts and fees to zero via `?? 0` fallbacks, masking data integrity issues. Hydration now throws `Invalid operation row <id>: missing required field "<field>"` when a required field is absent.
