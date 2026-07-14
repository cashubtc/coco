---
'@cashu/coco-core': major
'@cashu/coco-adapter-tests': major
'@cashu/coco-indexeddb': major
'@cashu/coco-expo-sqlite': major
'@cashu/coco-sql-storage': major
'@cashu/coco-sqlite': major
'@cashu/coco-sqlite-bun': major
---

Add payer-side NUT-18 P2PK payment request support.

Core now exposes normalized P2PK payment request requirements, filters payable
mints to those advertising NUT-11, and prepares payment request sends through
the general P2PK send handler with structured NUT-11 options from cashu-ts.
Adapter packages now require cashu-ts 4.6.1, and adapter contract coverage
checks that structured send method data remains persisted.
