---
status: accepted
---

# Stream safe resource invalidations

`GET /v1/events` streams safe resource invalidations for history, Operations, Quotes, Mints, and
balances rather than forwarding raw Coco events or acting as a second state feed. Consumers fetch
canonical resources after an event. A `mint.updated` event causes consumers to refetch the Known
Mint collection and select by normalized Mint URL; v1 does not add a singular Known Mint route.
Events have no replay or completeness guarantee, and cocod does not infer transitions Coco did not
emit. This covers changes that history alone misses while preventing proof-bearing event payloads
from crossing the network interface; complete transition coverage must first be implemented as a
public post-persistence event in Coco. Cocod bounds each client queue by dropping invalidations when
the stream consumer is not ready and periodically revalidates the stream's Client Credential.
