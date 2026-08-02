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
      repositories.keyRingRepository.reserveNextDerivationIndex('nut20_mint_quote'),
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
