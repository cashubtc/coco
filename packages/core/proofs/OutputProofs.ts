import { Amount } from '@cashu/cashu-ts';
import { normalizeUnit } from '@core/amounts.ts';
import { ProofValidationError } from '@core/models/Error.ts';
import type { CoreProof } from '@core/types.ts';
import { getSecretsFromSerializedOutputData, type SerializedOutputData } from '@core/utils.ts';

export function assertOutputProofs(command: {
  mintUrl: string;
  unit: string;
  outputData: SerializedOutputData;
  kind: 'keep' | 'send';
  state: CoreProof['state'];
  proofs: CoreProof[];
  createdByOperationId?: string;
}): void {
  const { proofs, state, kind } = command;
  const outputSecrets = getSecretsFromSerializedOutputData(command.outputData);
  const expectedSecrets = kind === 'keep' ? outputSecrets.keepSecrets : outputSecrets.sendSecrets;
  if (
    new Set(expectedSecrets).size !== expectedSecrets.length ||
    new Set(proofs.map((proof) => proof.secret)).size !== proofs.length ||
    proofs.length !== expectedSecrets.length
  ) {
    throw new ProofValidationError(`Swap ${kind} proofs do not match allocated outputs`);
  }
  const allocation = command.outputData[kind];
  const expected = new Map(
    allocation.map((output, index) => [
      expectedSecrets[index]!,
      {
        id: output.blindedMessage.id,
        amount: Amount.from(output.blindedMessage.amount),
      },
    ]),
  );
  for (const proof of proofs) {
    const output = expected.get(proof.secret);
    if (
      !output ||
      proof.id !== output.id ||
      !Amount.from(proof.amount).equals(output.amount) ||
      proof.mintUrl !== command.mintUrl ||
      normalizeUnit(proof.unit) !== normalizeUnit(command.unit) ||
      proof.state !== state ||
      proof.createdByOperationId !== command.createdByOperationId
    ) {
      throw new ProofValidationError(`Swap ${kind} proofs do not match allocated outputs`);
    }
  }
}
