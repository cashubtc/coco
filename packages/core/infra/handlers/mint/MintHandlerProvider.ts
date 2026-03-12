import type {
  MintMethod,
  MintMethodHandler,
  MintMethodHandlerRegistry,
} from '../../../operations/mint/MintMethodHandler';

/**
 * Runtime registry for mint method handlers.
 */
export class MintHandlerProvider {
  private registry: Partial<MintMethodHandlerRegistry> = {};

  constructor(initialHandlers?: Partial<MintMethodHandlerRegistry>) {
    if (initialHandlers) {
      this.registerMany(initialHandlers);
    }
  }

  register<M extends MintMethod>(method: M, handler: MintMethodHandler<M>): void {
    this.registry[method] = handler;
  }

  registerMany(handlers: Partial<MintMethodHandlerRegistry>): void {
    for (const [method, handler] of Object.entries(handlers)) {
      if (handler) {
        this.registry[method as MintMethod] = handler;
      }
    }
  }

  get<M extends MintMethod>(method: M): MintMethodHandler<M> {
    const handler = this.registry[method];
    if (!handler) {
      throw new Error(`No mint handler registered for method ${method}`);
    }
    return handler as MintMethodHandler<M>;
  }

  getAll(): MintMethodHandlerRegistry {
    return this.registry as MintMethodHandlerRegistry;
  }
}
