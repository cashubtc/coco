import type {
  MeltMethod,
  MeltMethodHandler,
  MeltMethodHandlerRegistry,
} from '../../../operations/melt/MeltMethodHandler';

/** Lookup for melt method handlers fixed at construction. */
export class MeltHandlerProvider {
  private readonly registry: Readonly<Partial<MeltMethodHandlerRegistry>>;

  constructor(initialHandlers: Partial<MeltMethodHandlerRegistry> = {}) {
    this.registry = Object.freeze({ ...initialHandlers });
  }

  get<M extends MeltMethod>(method: M): MeltMethodHandler<M> {
    const handler = this.registry[method];
    if (!handler) {
      throw new Error(`No melt handler registered for method ${method}`);
    }
    return handler as MeltMethodHandler<M>;
  }
}
