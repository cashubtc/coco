---
status: accepted
---

# Replace the Unix socket with one authenticated TCP interface

Cocod uses one HTTP listener over TCP instead of retaining separate local and network transports.
It binds to `127.0.0.1:62626` by default, serves the new `/v1` resources and authenticated legacy
command routes together during migration, and removes the Unix listener. Browser clients and CORS
are outside v1 scope. This keeps one protocol shape for the CLI, agents, and remote automation while
allowing the legacy wallet commands to migrate incrementally.

The authenticated interface includes process shutdown because the shared `wallet:admin` credential
already represents root Wallet authority. Local and remote `cocod stop` use the same endpoint; an
external supervisor may restart the process. The CLI auto-starts cocod only when no endpoint was
specified and it is using the local default. An explicit `--url` or `COCOD_URL` always selects
client-only behavior and never starts a process.
