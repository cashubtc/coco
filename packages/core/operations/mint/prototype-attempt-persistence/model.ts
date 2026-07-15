type OperationState = 'pending' | 'prepared' | 'executing' | 'finalized' | 'failed';
type AttemptState = 'prepared' | 'submitting' | 'succeeded' | 'rejected' | 'recovering';

export interface MintOperationRow {
  id: string;
  quoteId: string;
  amount: number;
  state: OperationState;
  attemptId: string | null;
  proofs: string[];
}

export interface MintIssuanceAttemptRow {
  id: string;
  mintUrl: string;
  method: 'bolt11';
  unit: string;
  state: AttemptState;
  memberOperationIds: string[];
  quoteIds: string[];
  quoteAmounts: number[];
  keysetId: string;
  counterStart: number;
  counterEnd: number;
  outputData: string[];
  submittedAt: number | null;
  recoveredAt: number | null;
  error: string | null;
}

export interface ProofRow {
  secret: string;
  amount: number;
  state: 'ready';
  createdByAttemptId: string;
  createdByOperationId: string | null;
}

export interface PrototypeState {
  now: number;
  counters: Record<string, number>;
  operations: Record<string, MintOperationRow>;
  attempts: Record<string, MintIssuanceAttemptRow>;
  proofs: Record<string, ProofRow>;
  log: string[];
}

type Tx = PrototypeState;

const MINT_URL = 'https://mint.example';
const KEYSET_ID = 'ks1';
const UNIT = 'sat';

export function initialState(): PrototypeState {
  return {
    now: 1,
    counters: { [`${MINT_URL}:${KEYSET_ID}`]: 0 },
    operations: {
      op1: pendingOp('op1', 'q1', 21),
      op2: pendingOp('op2', 'q2', 21),
      op3: pendingOp('op3', 'q3', 8),
    },
    attempts: {},
    proofs: {},
    log: ['Ready: three pending PAID BOLT11 operations can be reserved.'],
  };
}

function pendingOp(id: string, quoteId: string, amount: number): MintOperationRow {
  return { id, quoteId, amount, state: 'pending', attemptId: null, proofs: [] };
}

function cloneState(state: PrototypeState): PrototypeState {
  return {
    now: state.now,
    counters: { ...state.counters },
    operations: Object.fromEntries(
      Object.entries(state.operations).map(([id, op]) => [id, { ...op, proofs: [...op.proofs] }]),
    ),
    attempts: Object.fromEntries(
      Object.entries(state.attempts).map(([id, attempt]) => [
        id,
        {
          ...attempt,
          memberOperationIds: [...attempt.memberOperationIds],
          quoteIds: [...attempt.quoteIds],
          quoteAmounts: [...attempt.quoteAmounts],
          outputData: [...attempt.outputData],
        },
      ]),
    ),
    proofs: Object.fromEntries(
      Object.entries(state.proofs).map(([secret, proof]) => [secret, { ...proof }]),
    ),
    log: [...state.log],
  };
}

function transact(state: PrototypeState, fn: (tx: Tx) => void): PrototypeState {
  const tx = cloneState(state);
  try {
    fn(tx);
    tx.now += 1;
    return tx;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return appendLog(state, `ROLLBACK: ${message}`);
  }
}

function appendLog(state: PrototypeState, message: string): PrototypeState {
  return { ...state, log: [...state.log.slice(-8), message] };
}

function requireAttempt(tx: Tx): MintIssuanceAttemptRow {
  const [attempt] = Object.values(tx.attempts);
  if (!attempt) {
    throw new Error('no persisted attempt exists');
  }
  return attempt;
}

function coalesceOutputs(total: number, counterStart: number): string[] {
  const outputs: string[] = [];
  let remaining = total;
  let counter = counterStart;
  for (const amount of [64, 32, 16, 8, 4, 2, 1]) {
    while (remaining >= amount) {
      outputs.push(`out:${KEYSET_ID}:${counter}:${amount}`);
      counter += 1;
      remaining -= amount;
    }
  }
  return outputs;
}

export type Action =
  | 'reserve'
  | 'crash'
  | 'finalize'
  | 'reject'
  | 'mark-recovering'
  | 'reset';

export function reduce(state: PrototypeState, action: Action): PrototypeState {
  if (action === 'reset') return initialState();

  if (action === 'crash') {
    return appendLog(
      state,
      'Restart: ephemeral scheduler state vanished; persisted attempts and prepared members remain.',
    );
  }

  if (action === 'reserve') {
    return transact(state, (tx) => {
      if (Object.keys(tx.attempts).length > 0) {
        throw new Error('prototype keeps one attempt at a time');
      }

      const members = Object.values(tx.operations).filter((op) => op.state === 'pending');
      if (members.length < 2) {
        throw new Error('batch attempt needs at least two pending members');
      }

      const counterKey = `${MINT_URL}:${KEYSET_ID}`;
      const counterStart = tx.counters[counterKey] ?? 0;
      const total = members.reduce((sum, op) => sum + op.amount, 0);
      const outputData = coalesceOutputs(total, counterStart);
      const counterEnd = counterStart + outputData.length;
      const attemptId = `attempt-${tx.now}`;

      tx.attempts[attemptId] = {
        id: attemptId,
        mintUrl: MINT_URL,
        method: 'bolt11',
        unit: UNIT,
        state: 'prepared',
        memberOperationIds: members.map((op) => op.id),
        quoteIds: members.map((op) => op.quoteId),
        quoteAmounts: members.map((op) => op.amount),
        keysetId: KEYSET_ID,
        counterStart,
        counterEnd,
        outputData,
        submittedAt: null,
        recoveredAt: null,
        error: null,
      };

      tx.counters[counterKey] = counterEnd;
      for (const member of members) {
        tx.operations[member.id] = {
          ...member,
          state: 'prepared',
          attemptId,
        };
      }
      tx.log.push(
        `COMMIT: ${attemptId} owns members, counters ${counterStart}-${counterEnd - 1}, and outputData.`,
      );
    });
  }

  if (action === 'mark-recovering') {
    return transact(state, (tx) => {
      const attempt = requireAttempt(tx);
      if (attempt.state !== 'prepared' && attempt.state !== 'submitting') {
        throw new Error(`cannot recover attempt in ${attempt.state}`);
      }
      tx.attempts[attempt.id] = {
        ...attempt,
        state: 'recovering',
        submittedAt: attempt.submittedAt ?? tx.now,
      };
      for (const operationId of attempt.memberOperationIds) {
        tx.operations[operationId] = { ...tx.operations[operationId]!, state: 'executing' };
      }
      tx.log.push(`COMMIT: ${attempt.id} is the exact recovery boundary after ambiguous submit.`);
    });
  }

  if (action === 'finalize') {
    return transact(state, (tx) => {
      const attempt = requireAttempt(tx);
      if (attempt.state === 'succeeded' || attempt.state === 'rejected') {
        throw new Error(`attempt already ${attempt.state}`);
      }
      const proofSecrets = attempt.outputData.map((output) => output.replace('out:', 'proof:'));
      for (const secret of proofSecrets) {
        tx.proofs[secret] = {
          secret,
          amount: Number(secret.split(':').at(-1)),
          state: 'ready',
          createdByAttemptId: attempt.id,
          createdByOperationId: null,
        };
      }
      for (const operationId of attempt.memberOperationIds) {
        tx.operations[operationId] = {
          ...tx.operations[operationId]!,
          state: 'finalized',
          proofs: proofSecrets,
        };
      }
      tx.attempts[attempt.id] = {
        ...attempt,
        state: 'succeeded',
        submittedAt: attempt.submittedAt ?? tx.now,
        recoveredAt: attempt.state === 'recovering' ? tx.now : attempt.recoveredAt,
      };
      tx.log.push(
        `COMMIT: proofs are ready and every member finalized in the same transaction.`,
      );
    });
  }

  return transact(state, (tx) => {
    const attempt = requireAttempt(tx);
    if (attempt.state === 'succeeded' || attempt.state === 'rejected') {
      throw new Error(`attempt already ${attempt.state}`);
    }
    for (const operationId of attempt.memberOperationIds) {
      tx.operations[operationId] = {
        ...tx.operations[operationId]!,
        state: 'pending',
        attemptId: null,
      };
    }
    tx.attempts[attempt.id] = {
      ...attempt,
      state: 'rejected',
      submittedAt: attempt.submittedAt ?? tx.now,
      error: 'confirmed atomic non-issuance',
    };
    tx.log.push(
      `COMMIT: confirmed rejection keeps ${attempt.id} historical and returns members to pending.`,
    );
  });
}

