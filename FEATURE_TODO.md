# Cocod CLI v1 Lifecycle Alignment

- [x] Verify authenticated TCP and lifecycle v1 are merged into `master`.
- [x] Read the Cocod Host and Coco Cashu context documents and lifecycle ADRs.
- [x] Add focused client and route tests for the v1 cutover.
- [x] Introduce one typed v1 client interface with structured error parsing.
- [x] Move CLI health, status, Wallet initialization, and Coco Session commands to v1.
- [x] Keep Cocod Process reachability separate from Coco Session readiness.
- [x] Remove `/ping`, `/status`, `/init`, and `/unlock` from the daemon.
- [x] Update CLI help and daemon API documentation.
- [x] Build, typecheck, and test `cocod`.

## CLI naming

- Use `health` for public Cocod Process liveness.
- Use `wallet initialize` for host-generated Wallet Recovery Material.
- Use `session start` and `session stop` for Coco Session lifecycle transitions.
- Keep top-level `stop` for Cocod Process shutdown.
- Do not retain `ping`, `init`, or `unlock` aliases.

## Scope boundary

Keep balance, receive, send, mint, history, event, NPC, and X-Cashu routes on their existing
authenticated legacy contracts until their v1 resources are designed.
