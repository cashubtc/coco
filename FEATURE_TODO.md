# Cocod Lifecycle and Network Interface Foundation

- [x] Audit the landed cocod daemon interface against the current Coco facade.
- [x] Read the domain glossary and relevant quote lifecycle ADRs.
- [x] Separate Wallet, Wallet Seed Access, and Coco Session lifecycle concepts.
- [x] Record Wallet Seed Access in the domain glossary.
- [x] Remove the assumption that passphrase encryption is the required Seed Access mechanism.
- [x] Remove the hypothetical Wallet Seed adapter and expose seed custody as a product decision.
- [x] Specify an optional passphrase and derive unattended Coco Session start from its absence.
- [x] Specify cocod process startup and its unattended and locked branches.
- [x] Draft the proposed v1 lifecycle interactions and HTTP contract.
- [x] Replace the transport-coupled daemon state manager with `CocodRuntime`.
- [x] Keep the existing Unix interface as an adapter over the lifecycle module.
- [x] Bind the Unix listener before unattended Coco Session startup.
- [x] Cover concurrent start, stop-during-start, retry, and quarantine transitions.
- [ ] Review and resolve the open lifecycle decisions with maintainers.
- [ ] Specify balances, mints, quotes, and operations after the lifecycle is accepted.

## Scope boundaries

- Do not implement the TCP listener or client authentication in this slice.
- Keep one Wallet per cocod process for the first interface version.
- Do not expose Coco `Manager` objects or persistence models directly.
- Do not redesign quote or operation semantics owned by Coco.
- Keep the existing Unix-socket interface documented as the current implementation.
