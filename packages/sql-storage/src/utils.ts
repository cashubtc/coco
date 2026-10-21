export function getUnixTimeSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function hexToBytes(hexString: string): Uint8Array {
  if (!/^[0-9a-fA-F]+$/.test(hexString)) {
    throw new Error('Invalid hex string: contains non-hex characters');
  }

  if (hexString.length % 2 !== 0) {
    throw new Error(`Invalid hex string: odd length (${hexString.length})`);
  }

  const matches = hexString.match(/.{2}/g);
  if (!matches) {
    throw new Error('Failed to parse hex string');
  }

  return new Uint8Array(matches.map((byte) => parseInt(byte, 16)));
}

export function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function assertFieldPresent(
  value: string | number | null | undefined,
  field: string,
  operationId: string,
): string | number {
  if (value == null) {
    throw new Error(`Invalid operation row ${operationId}: missing required field "${field}"`);
  }
  return value;
}

function getSqliteErrorCode(error: unknown): string {
  if (typeof error !== 'object' || error === null) return '';
  if ('code' in error) return String((error as { code?: unknown }).code).toUpperCase();
  if ('errno' in error) return String((error as { errno?: unknown }).errno).toUpperCase();
  return '';
}

export function hasSqliteTransactionConflictCode(error: unknown): boolean {
  const code = getSqliteErrorCode(error);
  return (
    code === '5' ||
    code === '6' ||
    code.startsWith('SQLITE_BUSY') ||
    code.startsWith('SQLITE_LOCKED')
  );
}

export function isSqliteTransactionConflict(error: unknown): boolean {
  if (hasSqliteTransactionConflictCode(error)) return true;

  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return (
    message.includes('database is locked') ||
    message.includes('database table is locked') ||
    message.includes('database is busy')
  );
}
