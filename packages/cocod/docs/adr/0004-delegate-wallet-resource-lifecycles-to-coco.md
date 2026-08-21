---
status: accepted
---

# Delegate Wallet resource lifecycles to Coco

Cocod is an authenticated network and CLI interface over one Wallet hosted through Coco, not a
second wallet framework. It delegates durable Mint, Quote, Operation, proof, history, recovery, and
concurrency behavior to Coco and its repositories. Cocod persists only hosting concerns such as its
configuration, Client Credential verifier, protected Wallet Recovery Material, and process
metadata; it does not add parallel resource stores, public-ID maps, durable idempotency ledgers, or
independent financial state machines. This keeps cocod opinionated about hosting and transport
without duplicating the lifecycle authority of the framework it exposes.

Cocod may group, rename, or simplify Coco's public interfaces into an opinionated machine-oriented
HTTP interface; it does not need to mirror Manager methods one for one. That abstraction remains
downstream: when cocod needs Wallet behavior that Coco does not expose, the capability is added to
Coco first. Cocod does not bypass Coco through direct repository access or create substitute
behavior locally.
