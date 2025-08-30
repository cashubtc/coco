# coco-cashu

coco-cashu is an all-in-one, batteries-included dev kit for building Cashu wallets and apps. It takes care of everything behind the scenes: counter management, mint updates and sync, quote creation and redemption, proof storage and state management, counters, and a typed event bus—so you can hook into it. The core is storage-agnostic with first-class adapters for SQLite3 and IndexedDB, and a simple repository interface if you want to bring your own persistence.

## Packages

- `packages/core` — storage-agnostic core with services, typed event bus, and in-memory repositories for testing.
- `packages/sqlite3` — SQLite3 repository implementations for Node (uses `sqlite3` npm package).
- `packages/indexeddb` — IndexedDB repository implementations for web.
- `packages/demo-cli` — Node CLI demo using the SQLite3 adapter.
- `packages/demo-web` — Vite web demo using the IndexedDB adapter.

## Philosophy

- **Modular and headless**: Bring your own storage and UI.
- **Strongly typed**: Clean TypeScript interfaces and event types.
- **Minimal dependencies**: Focus on correctness and clarity.

## Development

Use TypeScript for type checking and `tsdown` to build packages. See `packages/core/README.md` for API details and usage.
