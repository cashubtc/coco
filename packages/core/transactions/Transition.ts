import type { CoreTransaction } from './CoreTransaction.ts';

const TRANSITION_BODY = Symbol('transition');

/** Local work performed through a live transaction scope; never directly callable. */
export interface Transition<I, O> {
  readonly [TRANSITION_BODY]: (tx: CoreTransaction, input: I) => Promise<O>;
}

export function defineTransition<I, O>(
  body: (tx: CoreTransaction, input: I) => Promise<O>,
): Transition<I, O> {
  return Object.freeze({ [TRANSITION_BODY]: body });
}

/** Internal runner access. Coordinators and transition bodies use tx.perform instead. */
export function getTransitionBody<I, O>(transition: Transition<I, O>) {
  return transition[TRANSITION_BODY];
}
