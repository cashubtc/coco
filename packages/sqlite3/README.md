# coco-cashu sqlite3 adapter

> ⚠️ Alpha software: This library is under active development and APIs may change. Use with caution in production and pin versions.

## Install deps

```bash
npm i
```

## Build

```bash
npm run build
```

## Notes

- The `coco_cashu_keysets` table no longer has a foreign key to `coco_cashu_mints`. Keysets are deleted manually in the repository when a mint is deleted. This improves compatibility with backends that cannot perform async work inside transactions (e.g., IndexedDB) and avoids FK timing issues during initial sync.
