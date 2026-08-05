import { parentPort, workerData } from 'node:worker_threads';
import { Database } from 'bun:sqlite';
import { SqliteRepositories } from '../index.ts';

type AllocationWorkerData = {
  filename: string;
  count: number;
};

const { filename, count } = workerData as AllocationWorkerData;
const database = new Database(filename);
database.exec('PRAGMA busy_timeout = 5000');

try {
  const repositories = new SqliteRepositories({ database });
  const indexes = await Promise.all(
    Array.from({ length: count }, () =>
      repositories.keyRingRepository
        .deriveAndPersistKeyPair('nut20_mint_quote', (derivationIndex) => ({
          publicKeyHex: '03' + derivationIndex.toString(16).padStart(64, '0'),
          secretKey: new Uint8Array(32).fill((derivationIndex % 254) + 1),
          derivationIndex,
          purpose: 'nut20_mint_quote',
        }))
        .then((keyPair) => keyPair.derivationIndex),
    ),
  );
  parentPort?.postMessage({ indexes });
} catch (error) {
  parentPort?.postMessage({
    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
  });
} finally {
  database.close();
}
