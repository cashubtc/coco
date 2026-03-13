---
'coco-cashu-expo-sqlite': patch
'coco-cashu-sqlite-bun': patch
'coco-cashu-indexeddb': patch
'coco-cashu-sqlite3': patch
'coco-cashu-core': patch
---

Fix keyset denomination handling so mint key maps are preserved with string keys instead of being
coerced to `Number` before persistence. This avoids precision loss for large denomination keys, keeps
split logic limited to safe integer values, and adds storage migrations that clear cached keysets so
they are re-fetched in the corrected format.
