# Context Map

## Contexts

- [Coco Cashu](./packages/core/CONTEXT.md) — the seed-rooted wallet domain used by core,
  integrations, adapters, and public documentation
- [Cocod Host](./packages/cocod/CONTEXT.md) — the opinionated daemon and CLI that hosts Coco for
  local and network clients

## Relationships

- **Cocod Host → Coco Cashu**: cocod controls process-level access to one Wallet and delegates
  wallet, mint, quote, and operation behavior to a Coco Session.
- **Integrations → Coco Cashu**: React bindings, persistence adapters, adapter tests, and public
  documentation use the Coco Cashu language rather than defining separate domain contexts.
