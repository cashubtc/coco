# coco-cashu

Monorepo for modular Cashu tooling.

## Packages

- `packages/core` — storage-agnostic core with services, typed event bus, and in-memory repositories for testing.

## Getting started

```bash
bun install
```

Run a quick example from the core package:

```bash
cd packages/core
bun run index.ts
```

## Philosophy

- **Modular and headless**: Bring your own storage and UI.
- **Strongly typed**: Clean TypeScript interfaces and event types.
- **Minimal dependencies**: Focus on correctness and clarity.

## Development

Use Bun for scripts and TypeScript for type checking. See `packages/core/README.md` for API details and usage.
