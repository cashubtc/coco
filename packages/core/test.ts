import { Manager } from './Manager';
import { MemoryRepositories } from './repositories/memory/MemoryRepositories';

const repositories = new MemoryRepositories();

const testManager = new Manager(repositories);

async function logBalances() {
  const balances = await testManager.getBalances();
  console.log('Balances:', balances);
}

testManager.on('proofs:saved', logBalances);
testManager.on('proofs:state-changed', logBalances);

const mintUrl = 'https://nofees.testnut.cashu.space';

await testManager.addMint(mintUrl);
await testManager.addMint(mintUrl);

console.log('Minting...');
await testManager.mintProofs(mintUrl, 21);
console.log('Minting...');
await testManager.mintProofs(mintUrl, 21);
console.log('Minting...');
await testManager.mintProofs(mintUrl, 21);

const send = await testManager.send(mintUrl, 21);

await testManager.receive(send);
