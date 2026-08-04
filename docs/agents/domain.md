# Domain Docs

How the engineering skills should consume this repo's domain documentation.

## Before exploring, read these

- **`CONTEXT.md`** at the repository root.
- **`docs/adr/`**; read ADRs relevant to the area being changed.

If either is absent, proceed silently. The `/domain-modeling` skill creates domain
documentation lazily when terminology or decisions are resolved.

## File structure

This is a single-context repository:

```
/
├── CONTEXT.md
├── docs/adr/
└── packages/
    ├── adapter-tests/
    ├── core/
    ├── docs/
    ├── expo-sqlite/
    ├── indexeddb/
    ├── react/
    ├── sql-storage/
    ├── sqlite-bun/
    └── sqlite3/
```

## Use the glossary's vocabulary

When output names a domain concept, use the term defined in `CONTEXT.md`. Do not
drift to synonyms the glossary explicitly avoids.

If a needed concept is absent, reconsider whether the project uses that language or
note the gap for `/domain-modeling`.

## Flag ADR conflicts

If output contradicts an existing ADR, surface the conflict explicitly rather than
silently overriding it:

> _Contradicts ADR-0007 (event-sourced orders)—but worth reopening because…_
