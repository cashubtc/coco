---
'@cashu/coco-core': patch
'@cashu/coco-adapter-tests': patch
---

Make the proof-state watcher respect each proof's Owning Operation. SPENT evidence for Send-owned
proofs now goes only to the Send, and the watcher no longer marks those proofs spent directly when
the Send declines or fails. The watcher no longer subscribes to, state-checks, or writes
Melt-owned or other operation-owned inflight proofs; Melt settlement and release stay with the Melt
watcher and processor. Inflight proofs without an Owning Operation, including those whose referenced
operations are missing or finished, are marked spent on fresh SPENT evidence only if they are still
inflight and unowned when the change commits, as in released behaviour. UNSPENT and PENDING
evidence leaves them unchanged. The startup scan no longer contacts untrusted mints.
