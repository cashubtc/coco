# Adding a mint

Coco will not act on any unknown mints, meaning it will throw when you try to receive a token from a mint now known to coco. So you will have to add it first. Adding a mint will cause coco to get the latest mint info as well as the keysets and it will make sure to keep them updated as well.

```ts
const coco = initializeCoco({ repo, seedGetter });

const mintUrl = 'https://minturl.com';
await coco.mint.addMint(mintUrl);
// Once the mint has been added you can receive / mint on that mint
const quote = await coco.quotes.createMintQuote(mintUrl, 21);
```
