---
status: accepted
---

# Stream safe resource invalidations

`GET /v1/events` streams safe resource invalidations for history, Operations, Quotes, Mints, and
balances rather than forwarding raw Coco events or acting as a second state feed. Consumers fetch
canonical resources after an event. Events have no replay or completeness guarantee, and cocod
does not infer transitions Coco did not emit. This covers changes that history alone misses while
preventing proof-bearing event payloads from crossing the network interface; complete transition
coverage must first be implemented as a public post-persistence event in Coco.
