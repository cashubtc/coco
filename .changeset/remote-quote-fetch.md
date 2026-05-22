---
'@cashu/coco-core': major
---

Rename method handler quote refresh hooks to clarify lifecycle ownership.

`MintMethodHandler.refreshQuote` and `MeltMethodHandler.refreshQuote` are now
`fetchRemoteQuote`, with matching `FetchRemote*QuoteContext` types. Quote
lifecycle services continue to own canonical quote persistence and refresh
events.
