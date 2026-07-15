export type OwnershipModel = 'operation-owned' | 'dispatch-owned';

type OperationState = 'pending' | 'recovering' | 'finalized';

interface Output {
  id: string;
  amount: number;
  counter: number;
  owner: string;
}

interface MintOperation {
  id: string;
  quoteId: string;
  amount: number;
  state: OperationState;
  outputs: Output[];
}

interface MintDispatch {
  id: string;
  operationIds: string[];
  outputs: Output[];
  response: 'not-sent' | 'ambiguous' | 'success';
}

export interface PrototypeState {
  model: OwnershipModel;
  nextCounter: number;
  operations: MintOperation[];
  dispatch?: MintDispatch;
  lastAction: string;
}

export type Action =
  | { type: 'toggle-model' }
  | { type: 'reset' }
  | { type: 'add-operation' }
  | { type: 'assemble-batch' }
  | { type: 'ambiguous-response' }
  | { type: 'recover' }
  | { type: 'success' };

const DEFAULT_QUOTE_COUNT = 100;
const QUOTE_AMOUNT = 21;

function denominations(amount: number): number[] {
  const values: number[] = [];
  let remaining = amount;
  while (remaining > 0) {
    const denomination = 2 ** Math.floor(Math.log2(remaining));
    values.push(denomination);
    remaining -= denomination;
  }
  return values;
}

function allocateOutputs(
  nextCounter: number,
  amount: number,
  owner: string,
): { outputs: Output[]; nextCounter: number } {
  const outputs = denominations(amount).map((denomination, index) => {
    const counter = nextCounter + index;
    return { id: `output-${counter}`, amount: denomination, counter, owner };
  });
  return { outputs, nextCounter: nextCounter + outputs.length };
}

function appendOperation(state: PrototypeState): PrototypeState {
  if (state.dispatch) {
    return { ...state, lastAction: 'Reset before adding another operation.' };
  }

  const index = state.operations.length;
  const id = `mint-op-${index + 1}`;
  const allocation =
    state.model === 'operation-owned'
      ? allocateOutputs(state.nextCounter, QUOTE_AMOUNT, id)
      : { outputs: [], nextCounter: state.nextCounter };

  return {
    ...state,
    nextCounter: allocation.nextCounter,
    operations: [
      ...state.operations,
      {
        id,
        quoteId: `quote-${index + 1}`,
        amount: QUOTE_AMOUNT,
        state: 'pending',
        outputs: allocation.outputs,
      },
    ],
    lastAction:
      state.model === 'operation-owned'
        ? `${id} prepared and allocated ${allocation.outputs.length} outputs.`
        : `${id} prepared without consuming deterministic counters.`,
  };
}

function assembleBatch(state: PrototypeState): PrototypeState {
  if (state.dispatch || state.operations.length < 2) {
    return { ...state, lastAction: 'A batch needs two pending operations and can be built once.' };
  }

  let nextCounter = state.nextCounter;
  let outputs: Output[];
  if (state.model === 'operation-owned') {
    outputs = state.operations.flatMap((operation) => operation.outputs);
  } else {
    const totalAmount = state.operations.reduce((total, operation) => total + operation.amount, 0);
    const allocation = allocateOutputs(nextCounter, totalAmount, 'mint-dispatch-1');
    outputs = allocation.outputs;
    nextCounter = allocation.nextCounter;
  }

  return {
    ...state,
    nextCounter,
    dispatch: {
      id: 'mint-dispatch-1',
      operationIds: state.operations.map((operation) => operation.id),
      outputs,
      response: 'not-sent',
    },
    lastAction:
      state.model === 'operation-owned'
        ? `Concatenated ${outputs.length} outputs already owned by Mint Operations.`
        : `Persisted ${outputs.length} coalesced outputs owned by the dispatch attempt.`,
  };
}

function finalize(state: PrototypeState, action: string): PrototypeState {
  if (!state.dispatch) return { ...state, lastAction: 'Assemble the batch first.' };
  return {
    ...state,
    operations: state.operations.map((operation) => ({
      ...operation,
      state: 'finalized',
    })),
    dispatch: { ...state.dispatch, response: 'success' },
    lastAction: action,
  };
}

export function createState(model: OwnershipModel = 'operation-owned'): PrototypeState {
  let state: PrototypeState = {
    model,
    nextCounter: 0,
    operations: [],
    lastAction: 'Prototype initialized.',
  };
  for (let index = 0; index < DEFAULT_QUOTE_COUNT; index++) state = appendOperation(state);
  return {
    ...state,
    lastAction: `${DEFAULT_QUOTE_COUNT} quotes of ${QUOTE_AMOUNT} sat are pending.`,
  };
}

export function reduce(state: PrototypeState, action: Action): PrototypeState {
  switch (action.type) {
    case 'toggle-model': {
      if (state.dispatch) return { ...state, lastAction: 'Reset before changing ownership model.' };
      const model = state.model === 'operation-owned' ? 'dispatch-owned' : 'operation-owned';
      return {
        ...createState(model),
        lastAction: `Changed to ${model}; preparation was replayed under that ownership model.`,
      };
    }
    case 'reset':
      return createState(state.model);
    case 'add-operation':
      return appendOperation(state);
    case 'assemble-batch':
      return assembleBatch(state);
    case 'ambiguous-response':
      if (!state.dispatch) return { ...state, lastAction: 'Assemble the batch first.' };
      return {
        ...state,
        dispatch: { ...state.dispatch, response: 'ambiguous' },
        operations: state.operations.map((operation) => ({
          ...operation,
          state: 'recovering',
        })),
        lastAction: 'The atomic dispatch is ambiguous; every member waits on its recovery.',
      };
    case 'recover':
      if (!state.dispatch || state.dispatch.response !== 'ambiguous') {
        return { ...state, lastAction: 'Simulate an ambiguous response before recovery.' };
      }
      return finalize(
        state,
        `Restored the exact outputs persisted by ${
          state.model === 'dispatch-owned' ? 'the dispatch' : 'its member operations'
        }.`,
      );
    case 'success':
      return finalize(state, 'All quote-backed Mint Operations finalized from one atomic result.');
  }
}

export function view(state: PrototypeState): object {
  const totalAmount = state.operations.reduce((total, operation) => total + operation.amount, 0);
  const operationOutputCount = state.operations.reduce(
    (total, operation) => total + operation.outputs.length,
    0,
  );
  const stateCounts = Object.fromEntries(
    ['pending', 'recovering', 'finalized'].map((operationState) => [
      operationState,
      state.operations.filter((operation) => operation.state === operationState).length,
    ]),
  );
  const outputComposition = state.dispatch
    ? Object.fromEntries(
        [...new Set(state.dispatch.outputs.map((output) => output.amount))]
          .sort((left, right) => right - left)
          .map((amount) => [
            `${amount} sat`,
            state.dispatch?.outputs.filter((output) => output.amount === amount).length ?? 0,
          ]),
      )
    : {};

  return {
    ownershipModel: state.model,
    scenario: `${state.operations.length} quotes × ${QUOTE_AMOUNT} sat = ${totalAmount} sat`,
    allocationTiming:
      state.model === 'operation-owned'
        ? 'Each Mint Operation allocates outputs during prepare.'
        : 'The persisted dispatch allocates outputs immediately before sending.',
    nextCounter: state.nextCounter,
    operationOutputCount,
    mintOperationStates: stateCounts,
    dispatch: state.dispatch
      ? {
          response: state.dispatch.response,
          outputOwner:
            state.model === 'dispatch-owned' ? state.dispatch.id : 'individual Mint Operations',
          outputComposition,
          proofCount: state.dispatch.outputs.length,
          recoveryMaterial: `${state.dispatch.outputs.length} exact outputs persisted by ${
            state.model === 'dispatch-owned' ? state.dispatch.id : 'the member operations'
          }`,
        }
      : null,
    proofProvenance:
      state.model === 'dispatch-owned'
        ? 'Proofs belong to the dispatch; quotes still determine each operation outcome.'
        : 'Proofs retain per-operation output provenance.',
    lastAction: state.lastAction,
  };
}
