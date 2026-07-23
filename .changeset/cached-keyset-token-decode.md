---
'@cashu/coco-core': patch
---

Token decoding for a known mint now falls back to cached keysets when the mint refresh
fails (e.g. offline), and mint fetch failures are preserved as the `cause` of the thrown
`TokenValidationError` instead of being swallowed.
