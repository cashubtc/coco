import { IndexedDbRepositories } from 'coco-cashu-indexeddb';
import './style.css';
import { ConsoleLogger, getDecodedToken, getEncodedToken, Manager } from 'coco-cashu-core';
import * as bip39 from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english';

declare global {
  interface Window {
    coco: Manager;
    cocoUtils: { getEncodedToken: typeof getEncodedToken; getDecodedToken: typeof getDecodedToken };
    setMnemonic: (mnemonic: string) => void;
    getMnemonic: () => string | null;
  }
}

document.querySelector<HTMLDivElement>('#app')!.innerHTML = `
  <div>
    <h1>Coco-Cashu</h1>
    <p class="read-the-docs">
      Open your console and use window.coco to interact with coco-cashu
    </p>
  </div>
`;

let seed: Uint8Array | undefined;
const cachedMnemonic = localStorage.getItem('coco-mnemonic');
if (!cachedMnemonic) {
  const newMnemonic = bip39.generateMnemonic(wordlist);
  localStorage.setItem('coco-mnemonic', newMnemonic);
  seed = bip39.mnemonicToSeedSync(newMnemonic);
} else {
  seed = bip39.mnemonicToSeedSync(cachedMnemonic);
}

window.setMnemonic = (mnemonic: string) => {
  localStorage.setItem('coco-mnemonic', mnemonic);
  seed = bip39.mnemonicToSeedSync(mnemonic);
};

window.getMnemonic = () => {
  return localStorage.getItem('coco-mnemonic');
};

const repo = new IndexedDbRepositories({});
await repo.init();

window.coco = new Manager(repo, async () => seed, new ConsoleLogger(undefined, { level: 'debug' }));
window.cocoUtils = { getEncodedToken, getDecodedToken };
