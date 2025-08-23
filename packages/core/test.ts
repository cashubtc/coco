import { Manager } from "./Manager";
import { MemoryRepositories } from "./repositories/memory/MemoryRepositories";

const repositories = new MemoryRepositories();

const testManager = new Manager(repositories);

testManager.on("counter:updated", (counter) => {
  console.log("Counter updated:", counter.counter);
});

testManager.on("proofs:saved", async () => {
  const balances = await testManager.getBalances();
  console.log("Balances:", balances);
});

const mintUrl = "https://nofees.testnut.cashu.space";

await testManager.addMint(mintUrl);
await testManager.addMint(mintUrl);

console.log("Minting...");
await testManager.mintProofs(mintUrl, 21);
console.log("Minting...");
await testManager.mintProofs(mintUrl, 21);
console.log("Minting...");
await testManager.mintProofs(mintUrl, 21);

const finalBalance = await testManager.getBalances();
console.log("Final Balances: ", finalBalance);
