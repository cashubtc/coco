---
'@cashu/coco-core': patch
'@cashu/coco-adapter-tests': patch
---

Prepare for the cashu-ts 5.0.0-rc.13 upgrade without changing the dependency. The mint request
function now sends a pre-serialized request body byte-for-byte and serializes only object bodies,
memory repositories return a stored `Amount` by reference instead of copying its prototype, and
the Wallet Service builds its wallets with a pass-through proof selector so a Melt pre-swap spends
exactly the proofs the operation reserved. No consumer-visible behavior changes on rc.4.
