import { Database } from 'bun:sqlite';
import process from 'node:process';
import { allocateKeypairForTest } from '@cashu/coco-adapter-tests';
import { SqliteRepositories } from '../index.ts';

const filename = process.argv[2];
const count = Number(process.argv[3]);
if (!filename || !Number.isSafeInteger(count) || count <= 0) {
  throw new Error('Expected a database filename and positive allocation count');
}
const database = new Database(filename);
database.exec('PRAGMA busy_timeout = 5000');

try {
  const repositories = new SqliteRepositories({ database });
  const indexes = await Promise.all(
    Array.from({ length: count }, () =>
      allocateKeypairForTest(repositories, 'nut20_mint_quote').then(
        (keyPair) => keyPair.derivationIndex,
      ),
    ),
  );
  console.log(JSON.stringify(indexes));
} catch (error) {
  // Keep the original stack and SQLite error details in the parent test failure.
  console.error(error);
  process.exitCode = 1;
} finally {
  database.close();
}
