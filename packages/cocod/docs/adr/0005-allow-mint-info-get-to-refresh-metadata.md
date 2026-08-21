---
status: accepted
---

# Allow Mint information reads to refresh metadata

`GET /v1/mints/info` resolves Mint information through Coco even though Coco may contact the Mint
and update stale cached metadata while serving the read. This remains a `GET` because the client's
intent is to retrieve information and the incidental reconciliation does not initiate a financial
transition. Cocod does not add a separate forced-refresh command unless Coco first exposes that
capability; clients must nevertheless allow for Mint network latency and failure when reading the
resource.
