import type {
  BuiltInMeltMethod,
  GenericMeltMethod,
  MeltMethod,
  MeltMethodHandler,
  MeltMethodHandlerRegistry,
  ValidatedGenericMeltMethod,
} from '../../../operations/melt/MeltMethodHandler';

const BUILT_IN_MELT_METHODS = new Set<string>(['bolt11', 'bolt12', 'onchain']);

export function isBuiltInMeltMethod(method: string): method is BuiltInMeltMethod {
  return BUILT_IN_MELT_METHODS.has(method);
}

export function assertGenericMeltMethod<M extends string>(
  method: M,
): asserts method is GenericMeltMethod<M> {
  if (isBuiltInMeltMethod(method)) {
    throw new Error(`Built-in melt method ${method} must use its built-in handler path`);
  }
}

export function toGenericMeltMethod(method: string): ValidatedGenericMeltMethod {
  assertGenericMeltMethod(method);
  return method as ValidatedGenericMeltMethod;
}

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
    this.set(method, handler);
  }

  registerMany(handlers: Partial<MeltMethodHandlerRegistry>): void {
    for (const method of Object.keys(handlers) as MeltMethod[]) {
      const handler = handlers[method];
      if (handler) {
        this.set(method, handler as MeltMethodHandler<typeof method>);
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

  private set<M extends MeltMethod>(method: M, handler: MeltMethodHandler<M>): void {
    (this.registry as Partial<Record<M, MeltMethodHandler<M>>>)[method] = handler;
  }
}
