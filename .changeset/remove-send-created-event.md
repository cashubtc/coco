---
'@cashu/coco-core': major
---

Remove the undocumented `send:created` event from the public `CoreEvents` type. Consumers should use
`send:pending`, which is the emitted token-created send lifecycle event.
