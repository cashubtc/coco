# Coco core playground

```sh
bun install
bun run playground
```

This opens a Monaco editor at **http://127.0.0.1:5173**. Vite serves assets and
watches source files; all snippet execution, wallet state, and TypeScript language
services run in browser workers. There is no execution backend. Core is imported
from `packages/core/index.ts`, including the `/adapter` and `/plugin` entrypoints,
so no workspace build or published core package is needed.

## Editor and execution

Write multiline JavaScript or TypeScript, then click **Run** or press
**Ctrl/⌘-Enter**. Monaco provides syntax highlighting, API completion,
hover documentation, signature help, and TypeScript diagnostics using workspace
source and dependency types. Completion includes declarations from earlier runs.
Diagnostics are advisory; Run erases types and executes the snippet.

The last expression's value, console output, assertions, and errors appear in
Console. Events shows public `CoreEvents` subscriptions. Clear removes output
without changing state. The example menu loads snippets without executing them.

| Global                                                 | Value                                                                        |
| ------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `coco`                                                 | Initialized `Manager` with fresh `MemoryRepositories`                        |
| `core`                                                 | Public core runtime exports                                                  |
| `Amount`, `initializeCoco`, `MemoryRepositories`, etc. | Public runtime exports available by name                                     |
| `assert`                                               | Callable Chai assertion helper; `equal` and `notEqual` use strict comparison |
| `console`                                              | Captured log, info, warn, error, debug, dir, table, and assert methods       |

```ts
const pair = await coco.keyring.generateKeyPair();
assert.ok(await coco.keyring.getKeyPair(pair.publicKeyHex));
pair.publicKeyHex;
```

Replace the editor contents and run another snippet:

```ts
assert.equal((await coco.keyring.getAllKeyPairs()).length, 1);
pair.publicKeyHex;
```

Variables, closures, classes, functions, imports, and wallet data persist across
runs. Top-level `await` works. You can edit and rerun the buffer: a declaration
replaces that binding from an earlier run, and completion uses its latest type.
Other variables and wallet data remain available. Earlier closures read the latest
session bindings. `const` still cannot be reassigned with `=`, and duplicate lexical
declarations within the same snippet remain errors.
Runtime failures retain mutations made before the failure, as a REPL does.
Invalid JavaScript declarations are rejected before any code executes. Static
imports are available throughout the snippet, including above the import line.
Static modules and their requested exports are checked before session bindings
change or the snippet body runs. Empty imports (`import {} from 'module'`) still
load the module; `import type` declarations are erased.
Write snippets without `export` declarations.
Resource declarations (`using` and `await using`) are not supported and are
rejected before execution, including inside nested scopes. Use explicit cleanup
with `try` / `finally` instead.

Static and dynamic imports support `@cashu/coco-core`,
`@cashu/coco-core/adapter`, and `@cashu/coco-core/plugin`. They use the same bundled
workspace modules as the supplied globals:

```ts
import { Amount as CashuAmount } from '@cashu/coco-core';
assert.equal(CashuAmount, core.Amount);
CashuAmount.from(42).toNumber();
```

Other package imports are not bundled. Browser globals such as `fetch`,
`WebSocket`, `crypto`, and timers are available; Node and Bun APIs are not.
Snippets run with the browser worker's normal origin permissions. The evaluator
is a convenience REPL, not a security sandbox for untrusted code.

## Reset and session lifecycle

Click **Reset state**, press **Shift-Ctrl/⌘-Enter**, or run `.reset` / `:reset`.
Reset terminates the execution worker and creates a new Coco Session with fresh
memory repositories and a random 64-byte Wallet Seed. This clears bindings,
modules, timers, wallet data, and completion history, even during infinite loops
or pending promises. The editor and output remain for reference.

Refreshing or closing the page also discards the session. No wallet state or
snippet history is saved to disk or browser storage. Returning to the page through
the browser's back/forward cache starts a fresh session. Exceptions in timers and
unhandled promise rejections appear in Console without discarding the session.
Only one snippet executes at a time. Output is bounded to 64,000 characters per execution, and the UI
retains at most 500 entries and 500,000 characters.

Background Watchers and processors start disabled. Explicit APIs can contact
mints directly from the browser; the mint must allow the playground origin via
CORS. The mint example uses `http://localhost:3338`. Use test ecash: reset discards
local seed and wallet data, and cannot undo remote mint effects.

Commands entered alone: `.help`, `.examples`, `.example <name>`, `.clear`, and
`.reset`. Example names: `balances`, `keyring`, `persistence`, `amounts`, `mints`.

## Static build

```sh
bun run playground:build
bun run playground:preview
```

`dist/playground` contains the complete app, Monaco workers, execution worker,
and workspace type information. Serve that directory with any static HTTP
server (including beneath a path prefix). HTTPS or localhost supplies the secure
context needed by browser cryptography. After assets load, local wallet and
amount operations work without a server connection. Mint operations still need
network access. Changes to core source during development reload the page and
start a fresh session.

## Verification

```sh
bun run playground:typecheck
bun run playground:test
bunx playwright install chromium
bun run playground:test:browser
```

Browser tests build and serve the static app, then exercise real public API
mutations, source import identity, persistent state and closures, error recovery,
reset of stuck execution and old timers, typed completions and diagnostics,
offline execution, and desktop/narrow layouts. To test the development server
instead, set `PLAYGROUND_DEV_TEST=1`. Screenshots and failure traces are saved
under `test-results/playground`. Set `PLAYGROUND_TEST_PORT` to use a different
port while your own playground is running.
