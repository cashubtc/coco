# coco

A modular, TypeScript-first toolkit for building Cashu wallets and applications.

> ⚠️ Release candidate: Coco is stabilizing for v1, but breaking changes may
> still land before the final 1.0 release. Pin versions in production.

coco provides a complete foundation for Cashu development with a storage-agnostic
core that handles proof management, mint synchronization, quote lifecycle,
counter tracking, and state updates through a typed event bus. Published
packages now live under the `@cashu` npm scope.

Maintained adapters currently cover Node via `@cashu/coco-sqlite`, Bun via
`@cashu/coco-sqlite-bun`, web via `@cashu/coco-indexeddb`, and Expo/React
Native via `@cashu/coco-expo-sqlite`.

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
        │      @cashu/coco-core           │
        │                                  │
        │  • Services & Business Logic     │
        │  • Event Bus                     │
        │  • Repository Interfaces         │
        │  • Plugin System (lifecycle)     │
        │                                  │
        └────┬──────────────┬──────────┬────────────┘
             │              │          │
      depends│       depends│   depends│
             ▼              ▼          ▼
   ┌────────────────┐ ┌──────────┐ ┌──────────────┐
   │ SQLite Adapters│ │ IndexedDB│ │ Expo SQLite  │
   │   Node + Bun   │ │ Adapter  │ │   Adapter    │
   └────────────────┘ └──────────┘ └──────────────┘
```

## Packages

- `@cashu/coco-core` — storage-agnostic core with services, typed event bus, and
  in-memory repositories for testing.
- `@cashu/coco-react` — React hooks and providers for integrating a Coco
  `Manager` into UI code.
- `@cashu/coco-sqlite` — Node adapter built on `better-sqlite3`.
- `@cashu/coco-indexeddb` — IndexedDB adapter for web environments.
- `@cashu/coco-expo-sqlite` — Expo SQLite adapter for React Native and Expo.
- `@cashu/coco-sqlite-bun` — Bun adapter built on `bun:sqlite`.
- `@cashu/coco-adapter-tests` — reusable storage adapter contract test helpers.
- `packages/docs` — VitePress documentation site for the repository.

## Philosophy

- **Modular and headless**: Bring your own storage and UI.
- **Strongly typed**: Clean TypeScript interfaces and event types.
- **Minimal dependencies**: Focus on correctness and clarity.

## Plugins

The core exposes a minimal plugin API to hook into lifecycle events with access to specific services.

- See `packages/core/README.md` → Plugins for details and examples.
- Register at construction or via `manager.use(plugin)`; dispose with `manager.dispose()`.

## Development

This repo uses Bun workspaces. Most packages build with `tsdown`; the React
package builds with `tsc -b` and Vite, and the docs site uses VitePress.

```bash
bun install
bun run build
bun run typecheck
bun run docs:dev
```

See `packages/core/README.md` for API details and package-level usage.

## Contributing

Please see `CONTRIBUTING.md` for contributor workflow, testing commands, changesets,
and scoped conventional commit message guidance.
