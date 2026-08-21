---
status: accepted
---

# Return and recover sensitive Operation results

When Coco execution produces a distinct result such as an outgoing token, payment preimage, or
outpoint, cocod returns it alongside the safe Operation projection and also exposes it through the
Operation's authenticated result resource. Both responses use `Cache-Control: no-store`. Recovery
reads only data already retained by Coco, so a client can recover from a dropped execution response
without cocod creating a second result store. Ordinary Operation documents omit these results and
all proof-bearing or recovery-internal fields.
