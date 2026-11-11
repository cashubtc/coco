---
'@cashu/coco-core': minor
---

Expose `manager.ops.mintSwap` commands, local outcome waiting, and committed parent update events.
The API is available without feature configuration. Preparation does not pay; initial source
payment requires an explicit `execute` call.

Recover persisted swaps automatically using their durable retry schedule, with an independently
disableable Mint Swap processor that is enabled by default. Disabling it leaves explicit commands
available. Share operation locks with ordinary Mint/Melt services and reuse
existing session guards. One effect-driving Coco Session per Wallet store remains required.

Order overlapping pause/resume requests and drain admitted lifecycle work before Manager disposal
completes.

Defer committed quote and metadata events until coordinator locks are released, register independent parent interests with shared quote watchers, and preserve mint-provided retry delays. Fix a security issue in runtime diagnostics.

Keep exact recovery observations available after trust revocation. Disabling a quote watcher stops
ongoing observation without making the parent a replacement poller. Preserve bounded startup and
explicit recovery, fresh source non-payment confirmation, and durable retry deadlines. Requeue failed
Melt polling opportunities at the existing cadence while their subscriptions remain active.
