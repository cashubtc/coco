---
'@cashu/coco-core': patch
---

Memory repositories for counters, auth sessions, mints, keysets, keypairs, and Melt and Mint
operations now store and return detached copies. Mutating a value passed to or read from them no
longer changes the stored record without a repository write.
