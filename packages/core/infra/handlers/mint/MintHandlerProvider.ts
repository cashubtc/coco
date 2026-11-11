import type {
  MintMethod,
  MintMethodHandler,
  MintMethodHandlerRegistry,
} from '../../../operations/mint/MintMethodHandler';

/** Lookup for mint method handlers fixed at construction. */
export class MintHandlerProvider {
  private readonly registry: Readonly<Partial<MintMethodHandlerRegistry>>;

  constructor(initialHandlers: Partial<MintMethodHandlerRegistry> = {}) {
    this.registry = Object.freeze({ ...initialHandlers });
  }

  get<M extends MintMethod>(method: M): MintMethodHandler<M> {
    const handler = this.registry[method];
    if (!handler) {
      throw new Error(`No mint handler registered for method ${method}`);
    }
    return handler as MintMethodHandler<M>;
  }
}
