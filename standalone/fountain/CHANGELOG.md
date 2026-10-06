# @cashu/coco-fountain

## 0.1.0

- Import the binary fountain transport, Cashu helpers, and inbound UR reader from
  `nut-fountain` v0.1.0-alpha.1, including support for 1,024 source fragments and
  the independent 1 MiB message limit. Earlier version-1 readers support at most
  256 fragments.
- Align dependencies with Coco and preserve serialized Cashu witnesses with
  `@cashu/cashu-ts` 5.0.0-rc.4.
- Publish six entry points with browser and isolated package compatibility checks.
  Version and release this package independently of Coco's Changesets workspace.
