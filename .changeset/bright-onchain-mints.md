---
'@cashu/coco-core': patch
---

Fix reusable onchain mint quote redemption against NUT-30-capable mints.

Onchain mint capability checks now use the NUT-04 method metadata advertised by
current `mintd` releases, while legacy sat fallback remains limited to BOLT11.
NUT-20 mint quote keys now persist public keys that match the stored secp256k1
private key so `mintProofsOnchain` can sign funded quote redemptions reliably.
