# coco-cashu

A modular, TypeScript-first toolkit for building Cashu wallets and applications.

> ⚠️ Alpha software: This library is under active development and APIs may change. Use with caution in production and pin versions.

coco-cashu provides a complete foundation for Cashu development with a storage-agnostic core that handles all the complexity: proof management, mint synchronization, quote lifecycle, counter tracking, and state updates through a typed event bus. Choose from ready-to-use storage adapters (SQLite3, IndexedDB, Expo SQLite) or implement your own using the simple repository interface. For React developers, there's a dedicated wrapper with hooks and context providers for seamless integration.

## Architecture

```
                    ┌─────────────┐
                    │   React     │
                    │   Wrapper   │
                    └──────┬──────┘
                           │ consumes
                           ▼
        ┌──────────────────────────────────┐
        │                                  │
        │            @core                 │
        │                                  │
        │  • Services & Business Logic     │
        │  • Event Bus                     │
        │  • Repository Interfaces         │
        │  • Plugin System (lifecycle)     │
        │                                  │
        └────┬──────────┬──────────┬───────┘
             │          │          │
      depends│   depends│   depends│
             ▼          ▼          ▼
      ┌──────────┐ ┌──────────┐ ┌──────────┐
      │ SQLite3  │ │ IndexedDB│ │  Expo    │
      │ Adapter  │ │ Adapter  │ │  SQLite  │
      └──────────┘ └──────────┘ └──────────┘
         (Node)       (Web)       (Mobile)
```

## Packages

- `packages/core` — storage-agnostic core with services, typed event bus, plugin system, and in-memory repositories for testing.
- `packages/react` — React wrapper with hooks and context providers for easy integration in React apps.
- `packages/sqlite3` — SQLite3 repository implementations for Node (uses `sqlite3` npm package).
- `packages/indexeddb` — IndexedDB repository implementations for web.
- `packages/expo-sqlite` — Expo SQLite repository implementations for React Native.
- `packages/demo-cli` — Node CLI demo using the SQLite3 adapter.
- `packages/demo-web` — Vite web demo using the IndexedDB adapter.

## Philosophy

- **Modular and headless**: Bring your own storage and UI.
- **Strongly typed**: Clean TypeScript interfaces and event types.
- **Minimal dependencies**: Focus on correctness and clarity.

## Plugins

The core exposes a minimal plugin API to hook into lifecycle events with access to specific services.

- See `packages/core/README.md` → Plugins for details and examples.
- Register at construction or via `manager.use(plugin)`; dispose with `manager.dispose()`.

## Development

Use TypeScript for type checking and `tsdown` to build packages. See `packages/core/README.md` for API details and usage.
