import type {
  BuiltInMeltMethod,
  MeltMethod,
  MeltMethodHandler,
  MeltMethodHandlerRegistry,
} from '../../../operations/melt/MeltMethodHandler';
import { isBuiltInMeltMethod } from '../../../operations/melt/MeltMethodHandler';

/**
 * Runtime registry for melt method handlers.
 * Keeps wiring concerns out of the core melt domain.
 */
export class MeltHandlerProvider {
  private registry: Partial<Record<BuiltInMeltMethod, MeltMethodHandler<any>>> = {};
  private genericHandler?: MeltMethodHandler<any>;

  constructor(initialHandlers?: Partial<MeltMethodHandlerRegistry>) {
    if (initialHandlers) {
      this.registerMany(initialHandlers);
    }
  }

  register<M extends MeltMethod>(method: M, handler: MeltMethodHandler<M>): void {
    this.set(method, handler);
  }

  registerGeneric(handler: MeltMethodHandler<any>): void {
    this.genericHandler = handler;
  }

  registerMany(handlers: Partial<MeltMethodHandlerRegistry>): void {
    for (const method of Object.keys(handlers) as BuiltInMeltMethod[]) {
      const handler = handlers[method];
      if (handler) {
        this.set(method, handler as MeltMethodHandler<typeof method>);
      }
    }
  }

  get<M extends MeltMethod>(method: M): MeltMethodHandler<M> {
    const handler = isBuiltInMeltMethod(method) ? this.registry[method] : this.genericHandler;
    if (!handler) {
      throw new Error(`No melt handler registered for method ${method}`);
    }
    return handler as MeltMethodHandler<M>;
  }

  getAll(): MeltMethodHandlerRegistry {
    return this.registry as MeltMethodHandlerRegistry;
  }

  private set<M extends MeltMethod>(method: M, handler: MeltMethodHandler<M>): void {
    if (!isBuiltInMeltMethod(method)) {
      this.genericHandler = handler;
      return;
    }

    (this.registry as Partial<Record<M, MeltMethodHandler<M>>>)[method] = handler;
  }
}
