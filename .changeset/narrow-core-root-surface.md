---
'@cashu/coco-core': major
---

Narrow the root public entry point to app-facing wallet APIs, domain types, amount helpers,
logging, events, and `MemoryRepositories`.

Concrete services, operation service classes, repository contracts, individual memory
repositories, infra transports, handler providers, plugin internals, and adapter
serialization helpers are no longer exported from the package root. Storage adapter
authors should import persistence contracts from `@cashu/coco-core/adapter`, and plugin
authors should import extension contracts from `@cashu/coco-core/plugin`.
