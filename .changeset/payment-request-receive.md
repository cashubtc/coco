---
'@cashu/coco-core': minor
'@cashu/coco-indexeddb': minor
'@cashu/coco-expo-sqlite': minor
'@cashu/coco-sqlite': minor
'@cashu/coco-sqlite-bun': minor
'@cashu/coco-adapter-tests': minor
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
Pre-child crash attempts are discarded during recovery so redelivered payloads
can retry instead of being pinned to synthetic rejections.

Adapters now persist payment-request receive operations and attempts, and receive
operations store optional source metadata for request-linked receives.
