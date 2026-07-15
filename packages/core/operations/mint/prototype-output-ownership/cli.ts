import { createState, reduce, view, type Action } from './model.ts';

const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

let state = createState();

const actions: Record<string, Action> = {
  m: { type: 'toggle-model' },
  a: { type: 'add-operation' },
  b: { type: 'assemble-batch' },
  t: { type: 'ambiguous-response' },
  r: { type: 'recover' },
  s: { type: 'success' },
  x: { type: 'reset' },
};

function render(): void {
  console.clear();
  console.log(`${BOLD}PROTOTYPE — Mint Batch output ownership${RESET}`);
  console.log(
    `${DIM}Compare operation-owned concatenation with dispatch-owned coalescing.${RESET}\n`,
  );
  console.log(JSON.stringify(view(state), null, 2));
  console.log(
    `\n${BOLD}[m]${RESET} model  ${BOLD}[a]${RESET} add op  ${BOLD}[b]${RESET} build batch`,
  );
  console.log(
    `${BOLD}[t]${RESET} timeout  ${BOLD}[r]${RESET} recover  ${BOLD}[s]${RESET} success  ` +
      `${BOLD}[x]${RESET} reset  ${BOLD}[q]${RESET} quit`,
  );
}

render();
process.stdin.setRawMode?.(true);
process.stdin.resume();
process.stdin.setEncoding('utf8');

process.stdin.on('data', (key: string) => {
  if (key === 'q' || key === '\u0003') {
    process.stdin.setRawMode?.(false);
    process.stdin.pause();
    console.clear();
    return;
  }

  const action = actions[key];
  if (action) state = reduce(state, action);
  render();
});
