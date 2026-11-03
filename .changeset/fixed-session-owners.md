---
'@cashu/coco-core': major
---

Fix Background Watcher and Background Processor selection and options for each Coco Session.
Remove all six Manager enable/disable pairs for Mint, Melt and Proof watchers, Mint processing,
Melt settlement and Mint Swap processing. Configure them through `initializeCoco({ watchers,
processors })`; `disabled: true` omits that owner for the whole session. Use `dispose()` for final
cleanup. Changing selection requires a new Session and its normal startup recovery.

Networking-only `ensureSubscriptions()` does not activate owners, scan storage or run recovery.
Existing one-time Send, Melt, payment-request Receive, Mint/Batch recovery still runs even when all
owners are omitted. Mint Swap automatic recovery keeps its existing selection semantics. Explicit
operations and recovery APIs remain available. Proof watcher shutdown still allows started work to
finish under ADR-0014; other drain guarantees are unchanged. No persistence migration is needed.

Unresolved before shipping: direct Manager construction remains, but migration from its documented
manual activation sequence has not been decided. No public activation API or factory-only creation
requirement is introduced. Import preparation (#604) and temporary suspension remain separate work.
