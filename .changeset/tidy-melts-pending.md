---
'@cashu/coco-core': patch
---

Record mint-held Melt inputs as pending within the owning operation's transaction. Preserve exact
requests and proof ownership through ambiguous outcomes, settlement, and recovery, including older
persisted inflight inputs. Send proof states and balance semantics are unchanged.

Melt inputs are now persisted with the proof state `pending`, and `proofs:state-changed` reports
`pending` instead of `inflight` when a Melt starts executing. Earlier releases cannot recover a Melt
whose inputs are stored as `pending`.
