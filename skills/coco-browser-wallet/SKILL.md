---
name: coco-browser-wallet
description: Build browser Cashu wallets with Coco. Use when integrating Coco into a web app, adding ecash or Lightning wallet flows, or wiring Coco React providers and hooks.
---

# Build a browser wallet with Coco

Use Coco's public APIs to own proofs, counters, quotes, and durable operations. The app owns
Wallet Seed storage, browser lifecycle, and the user interface. A Wallet is the durable holding
context; a Coco Session is the running `Manager` returned by `initializeCoco()`.

## 1. Match the app and API version

Inspect the app's framework, client entry point, package manifest, and lockfile. Keep its existing
framework and package manager. Use `@cashu/coco-core` with `@cashu/coco-indexeddb`; add
`@cashu/coco-react` for React apps and check its React peer range before installing.

These examples use Coco's quote-first API: `quotes.mint.create()` followed by
`ops.mint.prepare({ quote, amount })`. Verify signatures and peer compatibility against the
installed packages' declarations and export maps before adapting examples. Import app APIs from
the package roots. Let Coco perform Cashu protocol calls and persistence through those APIs.

For API details, start with the [Coco docs](https://cashubtc.github.io/coco/). If the app uses a
prerelease or checkout, use its matching docs/source; the current repository's
`packages/core/api/`, `packages/core/Manager.ts`, and `packages/react/src/lib/` are authoritative
for that checkout. An installed copy of this skill does not require a Coco checkout.

**Done when:** the chosen package versions are compatible and the requested wallet actions map to
public APIs available in those versions.

## 2. Establish the browser session

Initialize from a client-only bootstrap after the wallet is unlocked. Keep IndexedDB, seed access,
and the Coco Session out of server rendering and server request handlers.

```ts
import { initializeCoco } from '@cashu/coco-core';
import { IndexedDbRepositories } from '@cashu/coco-indexeddb';

export async function openBrowserWallet(
  databaseName: string,
  seedGetter: () => Promise<Uint8Array>,
) {
  const repo = new IndexedDbRepositories({ name: databaseName });
  return initializeCoco({ repo, seedGetter });
}
```

`initializeCoco()` initializes the adapter and starts the default background watchers, processors,
and startup Operation Recovery. Keep those defaults unless the feature requires another policy.
Browser WebSocket support is detected automatically.

- Supply the same BIP39-derived seed bytes from `seedGetter` for every access to one Wallet.
  Coco does not persist the seed. Use the app's creation/import and unlock flow; persist recovery
  material before first use and preserve the mnemonic-to-seed derivation, including any passphrase.
  A missing or unreadable secret for an existing Wallet is an unlock/import error, not new-wallet
  creation.
- Keep a stable database name paired with that Wallet. Separate databases for different Wallets.
  Surface IndexedDB failures; clearing the database or falling back to memory loses durable state.
- For real funds, integrate the app's protected seed storage and recovery flow. Keep seeds,
  recovery material, and bearer tokens out of logs, analytics, URLs, and server props.
  `localStorageSeedGetter()` from `@cashu/coco-react` is an opt-in demo helper, unsuitable for real
  funds. It requires Web Locks in a secure browser context and does not create a mnemonic backup.
- Give session initialization one owner and share its promise across concurrent callers. Await
  `coco.dispose()` when that owner ends the session, including wallet switching. Dispose a session
  that finishes initializing after its owner has gone away. Choose one owning browser tab or
  implement explicit coordination; Coco events alone do not synchronize another tab's UI.

For React lifecycle and hook wiring, read [React integration](references/react.md).

**Done when:** reload opens the same Wallet and database, unavailable storage has a visible error
state, and remounts or wallet switching cannot leave duplicate sessions running.

## 3. Implement the requested wallet flows

Read the relevant sections of [Wallet flows](references/wallet-flows.md) for mint trust, balances,
ecash send/receive, Lightning mint/melt, or seed import and Restore. Build the requested subset;
use the advanced-feature links there only when those features are needed.

Prepare operations in response to a user action. Preparation can reserve funds and persist work.
Show the selected mint, unit, amount, and fees before executing a payment. Serialize actions for
each UI flow and render the persisted operation state as the authority for completion.

**Done when:** each requested action has working inputs, pending/error/completion states, and the
appropriate confirmation and cancellation behavior for its operation state.

## 4. Reconcile after interruptions

Retain operation IDs for resume screens; use `ops.<flow>.get(id)` and the corresponding list APIs
to discover persisted work after startup. Prepared operations still need a user decision. For
explicit refresh or recovery, use the flow's public `refresh` or recovery API supported by the
installed version.

A timeout is an ambiguous outcome. Reload the existing operation and reconcile it through Coco
before offering another attempt. Do not automatically cancel in an execution error handler,
create a replacement payment, release proofs, or edit operation records directly.

For live views, subscribe through `coco.on(...)`, filter operation events by `operationId` and
quote events by `{ mintUrl, quoteId }`, and call the returned unsubscribe functions on cleanup.
Subscribe before starting an action that can finish immediately, then reconcile from its return
value and persisted state. Events are best-effort notifications, so a view mounted after completion
must also load its current state. Quote payment observations and finalized wallet operations are
different milestones.

**Done when:** reopening a pending flow shows the existing operation, and a lost response or missed
event cannot make the UI report an unproven failure or initiate a duplicate payment.

## 5. Verify the integration

Run the app's relevant typecheck, build, and tests. Exercise these cases for the flows implemented,
using mocks or a designated test mint and test funds:

- Reload preserves wallet identity, mint selection, balances, history, and pending operations.
- Unknown mints require a trust decision; invalid amounts and insufficient spendable balance give
  actionable feedback.
- Preparing then cancelling releases the applicable reservation; double-clicking creates one flow.
- A delayed response, disconnect, or reload during execution resumes the persisted operation.
  A pending send or melt remains pending until Coco establishes its result.
- Browser initialization and teardown work under the framework's development remount behavior;
  a second tab follows the chosen ownership policy.

**Done when:** the requested flows pass relevant checks and the handoff names any untested live-mint
behavior or unfinished seed-storage/recovery integration. A demo seed helper is not production
readiness.
