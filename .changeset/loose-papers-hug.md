---
'coco-cashu-core': patch
'coco-cashu-adapter-tests': patch
---

Fix wallet restore and sweep to prevent state corruption

- Fixed an issue where `wallet.restore()` and `wallet.sweep()` could duplicate proofs and break spend state
- `wallet.sweep()` now throws an error when attempting to sweep from the same seed as the active wallet
- `wallet.restore()` now properly marks existing proofs as spent when the mint reports them spent
- Added `SeedService.seedEquals()` for comparing seeds
