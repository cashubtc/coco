# Core Transaction Hardening: Send and Receive (#444)

- [x] Build the composition-root-owned transaction runner on PR #457's strong repository scopes.
- [x] Route keypair allocation through a narrow transaction gateway.
- [x] Make Send preparation, exact execution, swap execution, completion, and recovery atomic.
- [x] Make Receive preparation, result application, and restart recovery atomic.
- [x] Persist exact signed requests before remote mint I/O and reuse them during recovery.
- [x] Keep remote mint I/O outside repository transactions.
- [x] Move revision authority and authoritative mutation reads inside domain gateways.
- [x] Publish live events only after commit and log listener failures.
- [x] Preserve legacy init cleanup and the existing pending default-token reclaim compatibility path.
- [x] Cover crash boundaries, adapter behavior, concurrency, replay, Restore, and idempotence.
- [x] Run the standards/spec review, resolve findings, and validate the integrated branch.

## Scope boundary

The durable outbox, general fault-injection framework, Payment Request parent/attempt atomicity,
Mint Swap migration, and pending default-token reclaim redesign remain separate follow-up work.
