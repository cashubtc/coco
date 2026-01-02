import type {
  MeltMethod,
  MeltMethodHandler,
  MeltMethodHandlerRegistry,
} from '../../operations/melt/MeltMethodHandler';

/**
 * Runtime registry for melt method handlers.
 * Keeps wiring concerns out of the core melt domain.
 */
export class MeltHandlerProvider {
  private registry: Partial<MeltMethodHandlerRegistry> = {};

  constructor(initialHandlers?: Partial<MeltMethodHandlerRegistry>) {
    if (initialHandlers) {
      this.registerMany(initialHandlers);
    }
  }

  register<M extends MeltMethod>(method: M, handler: MeltMethodHandler<M>): void {
    this.registry[method] = handler;
  }

  registerMany(handlers: Partial<MeltMethodHandlerRegistry>): void {
    for (const [method, handler] of Object.entries(handlers)) {
      if (handler) {
        this.registry[method as MeltMethod] = handler;
      }
    }
  }

  get<M extends MeltMethod>(method: M): MeltMethodHandler<M> {
    const handler = this.registry[method];
    if (!handler) {
      throw new Error(`No melt handler registered for method ${method}`);
    }
    return handler as MeltMethodHandler<M>;
  }

  getAll(): MeltMethodHandlerRegistry {
    return this.registry as MeltMethodHandlerRegistry;
  }
}
