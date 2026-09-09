---
'@cashu/coco-core': minor
---

Return an atomic `created` flag from Known Mint registration and commit metadata with its keysets
through the domain transaction gateway. Preserve concurrent trust decisions during refresh and
roll back incomplete keyset persistence. Expose typed operation lookup, state, and Payment Request
validation errors for machine clients such as cocod's v1 resource API.
