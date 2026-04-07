---
name: pre-alpha-migration
description: Use when upgrading an app or library from the legacy coco-cashu alpha packages to the stable @cashu/* release line. This skill covers dependency and import renames, sqlite3 to better-sqlite3 migration, manager and WalletApi replacement APIs, React hook updates, script and CI filter rewrites, and validation against existing persisted wallet data.
---

# Pre-Alpha Migration

## Overview

Use this skill to migrate a consumer codebase from the archived
`coco-cashu-*` alpha packages to the stable `@cashu/*` packages.

Treat this as a real API migration, not a package-name-only rename. The stable
release line removes alpha-era compatibility aliases across the manager,
wallet, and React hook surfaces.

## When To Use

Use this skill when a repo contains any of these signals:

- dependencies or imports named `coco-cashu-*`
- Bun workspace filters or CI scripts referencing `coco-cashu-*`
- Node code using `coco-cashu-sqlite3` with `sqlite3`
- manager calls such as `manager.send`, `manager.receive`, or
  `manager.recoverPending*`
- wallet calls such as `wallet.send()` or
  `wallet.processPaymentRequest()`
- React hooks such as `useSend()` or `useReceive()`

If none of those are present, say that the codebase does not appear to need the
alpha-to-stable migration.

## Workflow

1. Inspect the target repo before editing.
   Search for dependency names, imports, scripts, and removed APIs.
   Start with:
   ```sh
   rg -n "coco-cashu-|manager\\.(send|receive|quotes|recoverPending)|wallet\\.(send|processPaymentRequest|preparePaymentRequestTransaction|handle[A-Za-z]+PaymentRequest)|useSend\\(|useReceive\\(" .
   ```
2. Update package names first.
   Rewrite dependency names, import specifiers, workspace filters, and docs or
   script snippets that still reference `coco-cashu-*`.
3. Handle adapter migrations.
   For Node adapters, replace `coco-cashu-sqlite3` with `@cashu/coco-sqlite`
   and replace `sqlite3` with `better-sqlite3`.
   For Bun-only SQLite usage, prefer `@cashu/coco-sqlite-bun`.
4. Replace removed API surfaces.
   Move alpha manager flow calls to `manager.ops.*`.
   Move payment-request wrappers to `manager.paymentRequests.*`.
   Update one-shot wallet flow helpers to the new prepare/execute operation
   model.
5. Update React code if present.
   Replace removed hooks and adjust the calling convention and balance return
   shapes.
6. Preserve persisted wallet data.
   Keep the same repository or database location and initialize Coco normally.
   Do not introduce manual export and re-import steps unless the user explicitly
   asks for them.
7. Validate the migration.
   Reinstall dependencies, regenerate the lockfile, and run the most relevant
   build, typecheck, or test commands available in the consumer repo.

## Reference Use

Read [migration-reference.md](./references/migration-reference.md) when you need
the exact rename map, API replacements, React hook changes, balance shape
changes, or the final migration checklist.

## Implementation Notes

- Prefer targeted edits over blanket find-and-replace when code semantics
  changed.
- When migrating React hooks, update both the imported hook names and the
  method calls on the returned hook object.
- When migrating balance reads, account for the structured balance shape:
  `balances.byMint[mintUrl]?.total` and `balances.total.total`.
- If the target repo already mixes old and new packages, normalize everything to
  the stable `@cashu/*` line.
- Call out places where the old code relied on alpha convenience wrappers and
  the new API now requires explicit `prepare()`, `execute()`, `cancel()`, or
  `load()` steps.

## Completion Criteria

The migration is complete when:

- no `coco-cashu-*` package names remain
- removed alpha manager, wallet, and React hook APIs are gone
- scripts and workspace filters reference the stable package names
- the project installs cleanly with the chosen package manager
- the app starts against existing persisted data and key wallet flows still work
