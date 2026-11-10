---
'@cashu/coco-core': minor
---

Add `offline` to `ops.send.prepare`. It prepares a send from stored proofs and keysets without a
mint request, and succeeds only when those proofs add up to the amount as they are. Otherwise it
throws the new `OfflineSendError`, whose `reason` is `no_exact_match` or `unsupported_option`,
and reserves nothing. Ordinary input, balance and trust validation errors are unchanged. No
storage change.
