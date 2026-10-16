---
'@cashu/coco-core': minor
---

Add `offline: true` to send preparation. Exact sends use stored proofs and keysets without mint
requests, including after restart with stale metadata. Sends requiring a swap or a P2PK target fail
locally without retaining reservations. Reclaiming an executed token still requires the mint.
Offline selection deterministically finds exact binary compositions that randomized selection can
miss.
