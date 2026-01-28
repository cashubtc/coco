---
'coco-cashu-adapter-tests': patch
'coco-cashu-core': patch
---

feat: adds new methods to the WalletAPI:

- `WalletApi.encode`: This method encodes a Token into a V4 cashuB token
- `WalletApi.decode`: This method decodes a string token into its decoded Token form. It will use the internal keyset information to resolve short keyset IDs automatically
