---
'@cashu/coco-react': minor
---

Allow `CocoCashuProvider` to initialize Coco from a `CocoConfig` on initial
mount, with loading and error fallbacks, while preserving the existing
initialized-manager provider path. Add `localStorageSeedGetter()` as a browser
localStorage-backed seed getter helper for React applications.
