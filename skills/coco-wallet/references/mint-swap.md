# Mint Swap

Read the public [Mint Swap Operations guide](https://cashubtc.github.io/coco/pages/mint-swap-operations)
before building a cross-mint move.

- Require two distinct trusted mints with BOLT11 `sat` support and one stable caller-owned ID.
- `prepare()` persists bounds and exact children but never pays. Show those bounds before an
  explicit `execute()`.
- Treat `get()`, `listActive()`, and `waitForOutcome()` as passive. `refresh()` and
  `recovery.run()` are effect-driving reconciliation actions.
- Use one effect-driving Coco Session per Wallet store. The parent exclusively coordinates its
  exact children while active; after it stops, a child may resolve but cannot revise or reauthorize
  the parent.
- History lists expose one grouped parent row. Treat history and operation events as invalidations
  and reread durable state rather than splicing hints into a page.
- Render persisted economics only when present. A waiter timeout is local, and
  `needs_attention` is not successful settlement.
