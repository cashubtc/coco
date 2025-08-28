import { IndexedDbRepositories } from 'coco-cashu-indexeddb';
import './style.css';
import { ConsoleLogger, Manager } from 'coco-cashu-core';

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <div>
    <h1>Coco-Cashu</h1>
    <p class="read-the-docs">
      Open your console and use window.coco to interact with coco-cashu
    </p>
  </div>
`;

let seed: Uint8Array | undefined;
const cachedSeed = localStorage.getItem('coco-seed');
if (!cachedSeed) {
  const newSeed = window.crypto.getRandomValues(new Uint8Array(64));
  localStorage.setItem('coco-seed', JSON.stringify(Array.from(newSeed)));
  seed = newSeed;
} else {
  seed = new Uint8Array(JSON.parse(cachedSeed));
}

const repo = new IndexedDbRepositories({});
await repo.init();

window.coco = new Manager(repo, async () => seed, new ConsoleLogger(undefined, { level: 'debug' }));
