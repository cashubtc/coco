import { Database, SQLiteError } from 'bun:sqlite';
import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { CONFIG_DIR } from './utils/config.js';

const LOCK_DATABASE_NAME = 'daemon-lock.sqlite';

/** Reports that another Cocod Process currently owns the requested state directory. */
export class StateDirectoryLeaseUnavailableError extends Error {
  constructor(
    readonly stateDirectory: string,
    options?: ErrorOptions,
  ) {
    super(`Another Cocod process owns the state directory ${stateDirectory}`, options);
    this.name = 'StateDirectoryLeaseUnavailableError';
  }
}

/**
 * Holds exclusive process ownership of one Cocod state directory through SQLite's OS lock.
 * The dedicated database contains no application data and stays separate from the Wallet database.
 */
export class StateDirectoryLease {
  private released = false;

  private constructor(
    readonly stateDirectory: string,
    private readonly database: Database,
  ) {}

  static async acquire(stateDirectory = CONFIG_DIR): Promise<StateDirectoryLease> {
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    await chmod(stateDirectory, 0o700);

    const lockFile = join(stateDirectory, LOCK_DATABASE_NAME);
    let database: Database | undefined;
    try {
      database = new Database(lockFile, { create: true });
      database.exec(`
        PRAGMA busy_timeout = 0;
        PRAGMA journal_mode = DELETE;
        PRAGMA user_version = 1;
        BEGIN EXCLUSIVE;
      `);
      await chmod(lockFile, 0o600);
      return new StateDirectoryLease(stateDirectory, database);
    } catch (error) {
      database?.close();
      if (error instanceof SQLiteError && error.code === 'SQLITE_BUSY') {
        throw new StateDirectoryLeaseUnavailableError(stateDirectory, { cause: error });
      }
      throw new Error(`Failed to acquire Cocod state directory lease at ${stateDirectory}`, {
        cause: error,
      });
    }
  }

  async release(): Promise<void> {
    if (this.released) {
      return;
    }
    this.released = true;

    try {
      this.database.exec('ROLLBACK');
    } finally {
      this.database.close();
    }
  }
}
