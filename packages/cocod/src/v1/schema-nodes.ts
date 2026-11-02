/** Runtime validator paired with the JSON Schema emitted for the same document. */
export interface RuntimeSchema<T> {
  readonly name: string;
  readonly jsonSchema: Readonly<Record<string, unknown>>;
  parse(value: unknown): T;
}

/** One validated JSON value together with the JSON Schema that describes it. */
export interface SchemaNode {
  readonly jsonSchema: Readonly<Record<string, unknown>>;
  parse(value: unknown, path: string): unknown;
}

/** Largest amount a Cashu amount field can carry (unsigned 64-bit). */
const MAX_AMOUNT = 2n ** 64n - 1n;

/** Names a document schema; the type parameter is the document the parser returns. */
export function namedSchema<T>(name: string, node: SchemaNode): RuntimeSchema<T> {
  return {
    name,
    jsonSchema: node.jsonSchema,
    parse(value) {
      return node.parse(value, '$') as T;
    },
  };
}

export function literalNode<T extends string | null>(expected: T): SchemaNode {
  return {
    jsonSchema: expected === null ? { type: 'null' } : { const: expected },
    parse(value, path) {
      if (value !== expected) {
        throw new Error(`${path} must equal ${JSON.stringify(expected)}`);
      }
      return expected;
    },
  };
}

export function stringNode(
  options: {
    format?: 'date-time' | 'uri';
    pattern?: string;
    minLength?: number;
    maxLength?: number;
    sensitive?: boolean;
    description?: string;
  } = {},
): SchemaNode {
  return {
    jsonSchema: {
      type: 'string',
      ...(options.format ? { format: options.format } : {}),
      ...(options.pattern ? { pattern: options.pattern } : {}),
      ...(options.minLength !== undefined ? { minLength: options.minLength } : {}),
      ...(options.maxLength !== undefined ? { maxLength: options.maxLength } : {}),
      ...(options.sensitive ? { 'x-sensitive': true } : {}),
      ...(options.description ? { description: options.description } : {}),
    },
    parse(value, path) {
      if (typeof value !== 'string') {
        throw new Error(`${path} must be a string`);
      }
      if (options.pattern && !new RegExp(options.pattern).test(value)) {
        throw new Error(`${path} does not match the required pattern`);
      }
      if (options.minLength !== undefined && value.length < options.minLength) {
        throw new Error(`${path} is too short`);
      }
      if (options.maxLength !== undefined && value.length > options.maxLength) {
        throw new Error(`${path} is too long`);
      }
      if (
        options.format === 'date-time' &&
        (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value)
      ) {
        throw new Error(`${path} must be an RFC 3339 UTC timestamp`);
      }
      return value;
    },
  };
}

/** Lossless non-negative decimal integer amount used by response documents. */
export function amountNode(description?: string): SchemaNode {
  return decimalNode(/^(0|[1-9][0-9]*)$/, '^(0|[1-9][0-9]*)$', description);
}

/** Lossless positive decimal integer amount accepted by mutation requests. */
export function positiveAmountNode(description?: string): SchemaNode {
  return decimalNode(/^[1-9][0-9]*$/, '^[1-9][0-9]*$', description);
}

function decimalNode(expression: RegExp, pattern: string, description?: string): SchemaNode {
  return {
    jsonSchema: {
      type: 'string',
      pattern,
      maxLength: 20,
      ...(description ? { description } : {}),
    },
    parse(value, path) {
      if (typeof value !== 'string' || !expression.test(value)) {
        throw new Error(`${path} must be a decimal integer string`);
      }
      if (value.length > 20 || BigInt(value) > MAX_AMOUNT) {
        throw new Error(`${path} exceeds the largest supported amount`);
      }
      return value;
    },
  };
}

export function integerNode(options: { minimum?: number; maximum?: number } = {}): SchemaNode {
  return {
    jsonSchema: {
      type: 'integer',
      ...(options.minimum !== undefined ? { minimum: options.minimum } : {}),
      ...(options.maximum !== undefined ? { maximum: options.maximum } : {}),
    },
    parse(value, path) {
      if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        throw new Error(`${path} must be a safe integer`);
      }
      if (
        (options.minimum !== undefined && value < options.minimum) ||
        (options.maximum !== undefined && value > options.maximum)
      ) {
        throw new Error(`${path} is out of range`);
      }
      return value;
    },
  };
}

export function booleanNode(): SchemaNode {
  return {
    jsonSchema: { type: 'boolean' },
    parse(value, path) {
      if (typeof value !== 'boolean') {
        throw new Error(`${path} must be a boolean`);
      }
      return value;
    },
  };
}

export function enumNode<const T extends readonly string[]>(values: T): SchemaNode {
  return {
    jsonSchema: { enum: values },
    parse(value, path) {
      if (typeof value !== 'string' || !values.includes(value)) {
        throw new Error(`${path} must be one of ${values.join(', ')}`);
      }
      return value;
    },
  };
}

export function nullableNode(node: SchemaNode): SchemaNode {
  return unionNode([literalNode(null), node], 'anyOf');
}

export function arrayNode(item: SchemaNode): SchemaNode {
  return {
    jsonSchema: { type: 'array', items: item.jsonSchema },
    parse(value, path) {
      if (!Array.isArray(value)) {
        throw new Error(`${path} must be an array`);
      }
      return value.map((entry, index) => item.parse(entry, `${path}[${index}]`));
    },
  };
}

/** Any JSON value; used only for Mint-supplied data that cocod passes through unchanged. */
export function jsonValueNode(): SchemaNode {
  return {
    jsonSchema: {},
    parse(value, path) {
      assertJsonValue(value, path);
      return value;
    },
  };
}

export function objectNode(
  properties: Readonly<Record<string, SchemaNode>>,
  options: {
    optional?: readonly string[];
    additionalProperties?: boolean;
    /** Optional fields that may appear only together with the listed fields. */
    dependentRequired?: Readonly<Record<string, readonly string[]>>;
  } = {},
): SchemaNode {
  const optional = new Set(options.optional ?? []);
  const dependentRequired = options.dependentRequired ?? {};
  const additionalProperties = options.additionalProperties ?? false;
  const required = Object.keys(properties).filter((key) => !optional.has(key));
  return {
    jsonSchema: {
      type: 'object',
      additionalProperties,
      required,
      properties: Object.fromEntries(
        Object.entries(properties).map(([key, node]) => [key, node.jsonSchema]),
      ),
      ...(Object.keys(dependentRequired).length > 0 ? { dependentRequired } : {}),
    },
    parse(value, path) {
      const record = requireRecord(value, path);
      if (!additionalProperties) {
        requireOnlyKeys(record, Object.keys(properties), path);
      }
      const parsed: Record<string, unknown> = additionalProperties ? { ...record } : {};
      for (const [key, node] of Object.entries(properties)) {
        if (!(key in record) || (optional.has(key) && record[key] === undefined)) {
          if (optional.has(key)) {
            continue;
          }
          throw new Error(`${path}.${key} is required`);
        }
        parsed[key] = node.parse(record[key], `${path}.${key}`);
      }
      for (const [key, requirements] of Object.entries(dependentRequired)) {
        if (key in parsed && requirements.some((requirement) => !(requirement in parsed))) {
          throw new Error(`${path}.${key} requires ${requirements.join(', ')}`);
        }
      }
      return parsed;
    },
  };
}

export function unionNode(
  nodes: readonly SchemaNode[],
  keyword: 'oneOf' | 'anyOf' = 'oneOf',
): SchemaNode {
  return {
    jsonSchema: { [keyword]: nodes.map((node) => node.jsonSchema) },
    parse(value, path) {
      const matches: unknown[] = [];
      const errors: unknown[] = [];
      for (const node of nodes) {
        try {
          matches.push(node.parse(value, path));
        } catch (error) {
          errors.push(error);
        }
      }
      if (matches.length === 0 || (keyword === 'oneOf' && matches.length !== 1)) {
        throw new AggregateError(errors, `${path} does not match ${keyword}`);
      }
      return matches[0];
    },
  };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireOnlyKeys(
  value: Record<string, unknown>,
  allowedKeys: readonly string[],
  label: string,
): void {
  const allowed = new Set(allowedKeys);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new Error(`${label} contains an unexpected field`);
  }
}

function assertJsonValue(value: unknown, path: string): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`${path} must be a finite number`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertJsonValue(entry, `${path}[${index}]`));
    return;
  }
  if (typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) assertJsonValue(entry, `${path}.${key}`);
    return;
  }
  throw new Error(`${path} must be a JSON value`);
}
