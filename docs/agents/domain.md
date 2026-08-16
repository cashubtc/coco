# Domain Docs

How the engineering skills should consume this repo's domain documentation.

## Before exploring, read these

- **`CONTEXT-MAP.md`** at the repository root; read every context it routes for the area being
  changed.
- **Context-scoped `docs/adr/` directories**; read ADRs relevant to the area being changed.
- **`docs/adr/`** at the repository root when it exists; it contains cross-context decisions.

If any routed file or directory is absent, proceed silently. The `/domain-modeling` skill creates
domain documentation lazily when terminology or decisions are resolved.

## File structure

This is a multi-context repository:

```text
/
├── CONTEXT-MAP.md
├── docs/adr/                         # cross-context decisions, when needed
└── packages/
    ├── core/
    │   ├── CONTEXT.md
    │   └── docs/adr/                 # Coco Cashu decisions
    └── cocod/
        ├── CONTEXT.md
        └── docs/adr/                 # Cocod Host decisions, when needed
```

The root map is the authoritative routing table. Coco integrations, persistence adapters, adapter
tests, and public documentation use the Coco Cashu context. Cocod work reads both the Cocod Host
and Coco Cashu contexts because the host consumes the wallet domain.

## Use each glossary's vocabulary

When output names a domain concept, use the term defined in the routed `CONTEXT.md`. Do not drift
to synonyms the glossary explicitly avoids.

If a needed concept is absent, reconsider whether the project uses that language or note the gap
for `/domain-modeling`.

## Flag ADR conflicts

If output contradicts an existing ADR, surface the conflict explicitly rather than silently
overriding it:

> _Contradicts ADR-0007 (cashu-ts owns wire quote normalization)—but worth reopening because…_
