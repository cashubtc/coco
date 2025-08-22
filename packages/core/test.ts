import { Manager } from "./Manager";
import { MemoryMintRepository } from "./repositories/memory/MemoryMintRepository";
import { MemoryKeysetRepository } from "./repositories/memory/MemoryKeysetRepository";
import { MemoryCounterRepository } from "./repositories/memory/MemoryCounterRepository";

const mintRepository = new MemoryMintRepository();
const keysetRepository = new MemoryKeysetRepository();
const counterRepository = new MemoryCounterRepository();

const testManager = new Manager({
  mintRepository,
  counterRepository,
  keysetRepository,
});

testManager.on("counter:updated", (counter) => {
  console.log("Counter updated:", counter);
});

const mintUrl = "https://nofees.testnut.cashu.space";

// Register mint by URL; this fetches info and keysets once and persists in memory
await testManager.addMint(mintUrl);
const { wallet, keysetId } = await testManager.getWallet(mintUrl);
const currentCounter = await testManager.getCounter(mintUrl, keysetId);

const firstQuote = await wallet.createMintQuote(21);
const firstMint = await wallet.mintProofs(21, firstQuote.quote, { keysetId });
await testManager.incrementCounter(mintUrl, keysetId, firstMint.length);
