import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.tsx';
import { IndexedDbRepositories } from 'coco-cashu-indexeddb';
import { ConsoleLogger, Manager } from 'coco-cashu-core';

const repo = new IndexedDbRepositories({});
await repo.init();

const seed = window.crypto.getRandomValues(new Uint8Array(64));

export const manager = new Manager(
  repo,
  async () => seed,
  new ConsoleLogger(undefined, { level: 'debug' }),
);
await manager.mint.addMint('https://nofees.testnut.cashu.space');

createRoot(document.getElementById('root')!).render(<App />);
