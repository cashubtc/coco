import type { Token } from '@cashu/cashu-ts';
import type { PreparedReceiveOperation, ReceiveOperationSource } from './ReceiveOperation.ts';
import type { ReceiveOperationService } from './ReceiveOperationService.ts';

/** Prepares a new token. Recovery of a stored child continues from its existing operation. */
export async function prepareReceiveToken(
  service: Pick<ReceiveOperationService, 'init' | 'prepare'>,
  token: Token | string,
  source?: ReceiveOperationSource,
): Promise<PreparedReceiveOperation> {
  const draft = await service.init(token, source);
  return service.prepare(draft);
}
