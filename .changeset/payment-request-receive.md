---
'@cashu/coco-core': major
'@cashu/coco-indexeddb': major
'@cashu/coco-expo-sqlite': major
'@cashu/coco-sqlite': major
'@cashu/coco-sqlite-bun': major
'@cashu/coco-adapter-tests': major
---

Add incoming payment-request receive operations.

Core now exposes a payment-request receive saga that creates encoded requests,
claims incoming payloads into normal receive operations, deduplicates payloads,
records receive metadata for history, and reconciles pending child receive
operations during recovery.
Transport plugins can now register receive handlers for external transports such
as Nostr, and outgoing payment-request parsing exposes Nostr transport
descriptors for plugin delivery.
Incoming request creation stores active requests immediately; callers can
cancel requests to stop accepting future payloads while keeping request history.
Stored pre-child crash attempts are resumed during recovery; incomplete attempts
without a durable payload are rejected so they do not pin future deliveries.

Adapters now persist payment-request receive operations and attempts, and receive
operations store optional source metadata for request-linked receives.
