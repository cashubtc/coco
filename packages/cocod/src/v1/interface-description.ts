import { v1ErrorSchema, type V1RouteDefinition, type RuntimeSchema } from './http.js';

export interface V1InterfaceDescription {
  name: 'cocod-lifecycle-api';
  version: string;
  interfaceVersion: '1';
  schemas: Record<string, Readonly<Record<string, unknown>>>;
  routes: Array<{
    method: V1RouteDefinition['method'];
    path: string;
    capability: V1RouteDefinition['capability'];
    requestSchema: string | null;
    responseSchema: string;
    errorSchema: 'Error';
  }>;
}

/** Generates the machine-readable lifecycle interface from the schemas used by v1 routes. */
export function generateV1InterfaceDescription(
  definitions: ReadonlyArray<V1RouteDefinition>,
  daemonVersion: string,
): V1InterfaceDescription {
  const schemas: V1InterfaceDescription['schemas'] = {
    [v1ErrorSchema.name]: v1ErrorSchema.jsonSchema,
  };

  for (const definition of definitions) {
    addSchema(schemas, definition.responseSchema);
    if (definition.requestSchema.name !== 'NoBody') {
      addSchema(schemas, definition.requestSchema);
    }
  }

  return {
    name: 'cocod-lifecycle-api',
    version: daemonVersion,
    interfaceVersion: '1',
    schemas,
    routes: definitions.map((definition) => ({
      method: definition.method,
      path: definition.path,
      capability: definition.capability,
      requestSchema:
        definition.requestSchema.name === 'NoBody' ? null : definition.requestSchema.name,
      responseSchema: definition.responseSchema.name,
      errorSchema: 'Error',
    })),
  };
}

function addSchema(
  schemas: V1InterfaceDescription['schemas'],
  schema: RuntimeSchema<unknown>,
): void {
  const existing = schemas[schema.name];
  if (existing && JSON.stringify(existing) !== JSON.stringify(schema.jsonSchema)) {
    throw new Error(`Conflicting runtime schemas named ${schema.name}`);
  }
  schemas[schema.name] = schema.jsonSchema;
}
