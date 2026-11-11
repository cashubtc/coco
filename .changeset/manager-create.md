---
'@cashu/coco-core': major
---

Start Coco Sessions only with `initializeCoco(config)` or the new equivalent `Manager.create(config)`.
The `Manager` constructor is now private and `initPlugins()` is removed. Replace direct construction
plus manual activation with `initializeCoco({ plugins, watchers, processors })`; register later
plugins with `manager.use(plugin)`. No persistence migration is needed.
