---
'@cashu/coco-core': patch
---

Advance pending operations through configured background owners using persisted startup evidence and
runtime observations. Melt processors no longer fetch quote state to decide eligibility, Mint startup
discovery includes pending operations with complete quotes, and Send watching discovers locally spent
and supported legacy tokenless Sends. Preserve explicit checks and existing recovery sweeps.
