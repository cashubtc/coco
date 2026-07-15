import { initialState, reduce, type PrototypeState, type Action } from './model.ts';

const bold = '\x1b[1m';
const dim = '\x1b[2m';
const reset = '\x1b[0m';

let state = initialState();

function render(current: PrototypeState): void {
  console.clear();
  console.log(`${bold}PROTOTYPE - Mint Issuance Attempt Persistence${reset}`);
  console.log(`${dim}Throwaway state model for issue 331. No real database is used.${reset}\n`);

  console.log(`${bold}Counters${reset}`);
  console.log(JSON.stringify(current.counters, null, 2));

  console.log(`\n${bold}Mint Operations${reset}`);
  for (const operation of Object.values(current.operations)) {
    console.log(
      `${operation.id}: state=${operation.state} quote=${operation.quoteId} amount=${operation.amount} attempt=${operation.attemptId ?? '-'}`,
    );
  }

  console.log(`\n${bold}Mint Issuance Attempts${reset}`);
  const attempts = Object.values(current.attempts);
  if (attempts.length === 0) {
    console.log(`${dim}none${reset}`);
  } else {
    for (const attempt of attempts) {
      console.log(
        `${attempt.id}: state=${attempt.state} members=[${attempt.memberOperationIds.join(', ')}] outputs=${attempt.outputData.length} counters=${attempt.counterStart}-${attempt.counterEnd - 1}`,
      );
      console.log(`  quoteAmounts=[${attempt.quoteAmounts.join(', ')}] error=${attempt.error ?? '-'}`);
    }
  }

  console.log(`\n${bold}Proofs${reset}`);
  const proofs = Object.values(current.proofs);
  if (proofs.length === 0) {
    console.log(`${dim}none${reset}`);
  } else {
    for (const proof of proofs) {
      console.log(
        `${proof.secret}: state=${proof.state} attempt=${proof.createdByAttemptId} operation=${proof.createdByOperationId ?? '-'}`,
      );
    }
  }

  console.log(`\n${bold}Log${reset}`);
  for (const entry of current.log.slice(-8)) {
    console.log(`- ${entry}`);
  }

  console.log(`\n${bold}Keys${reset}`);
  console.log(
    `[r] reserve attempt  [c] crash/restart  [x] mark recovering  [f] finalize  [j] reject  [0] reset  [q] quit`,
  );
}

function dispatch(action: Action): void {
  state = reduce(state, action);
  render(state);
}

render(state);
if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
  console.log(`\n${dim}Open this in an interactive terminal to drive it with keys.${reset}`);
  process.exit(0);
}

process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding('utf8');
process.stdin.on('data', (key) => {
  if (key === 'q' || key === '\u0003') {
    process.stdin.setRawMode(false);
    process.stdin.pause();
    return;
  }

  const actions: Record<string, Action> = {
    r: 'reserve',
    c: 'crash',
    x: 'mark-recovering',
    f: 'finalize',
    j: 'reject',
    '0': 'reset',
  };

  const action = actions[key];
  if (action) {
    dispatch(action);
  }
});
