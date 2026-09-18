export type DecodePath = readonly (string | number)[];

export type DecodeIssue = {
  path: DecodePath;
  reason: string;
};

export type DecodeResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: DecodeIssue[] };

export type Decoder<T> = {
  decode: (input: unknown, path?: DecodePath) => DecodeResult<T>;
};

export type InferDecoder<TDecoder> =
  TDecoder extends Decoder<infer TValue> ? TValue : never;

type DecoderShape = Record<string, Decoder<unknown>>;
type InferShape<TShape extends DecoderShape> = {
  -readonly [TKey in keyof TShape]: InferDecoder<TShape[TKey]>;
};

export class BoundaryDecodeError extends Error {
  readonly issues: DecodeIssue[];

  constructor(context: string, issues: DecodeIssue[]) {
    const summary = issues
      .slice(0, 5)
      .map(({ path, reason }) => `${formatPath(path)}: ${reason}`)
      .join('; ');
    super(`${context} failed validation${summary ? ` (${summary})` : ''}`);
    this.name = 'BoundaryDecodeError';
    this.issues = issues;
  }
}

function formatPath(path: DecodePath): string {
  if (path.length === 0) return '$';
  return path.reduce<string>(
    (result, segment) =>
      typeof segment === 'number'
        ? `${result}[${segment}]`
        : `${result}.${segment}`,
    '$',
  );
}

function success<T>(value: T): DecodeResult<T> {
  return { ok: true, value };
}

function failure(path: DecodePath, reason: string): DecodeResult<never> {
  return { ok: false, issues: [{ path, reason }] };
}

export function decodeOrThrow<T>(
  decoder: Decoder<T>,
  input: unknown,
  context: string,
): T {
  const result = decoder.decode(input);
  if (!result.ok) throw new BoundaryDecodeError(context, result.issues);
  return result.value;
}

export function stringDecoder(options: {
  minLength?: number;
  maxLength: number;
}): Decoder<string> {
  return {
    decode(input, path = []) {
      if (typeof input !== 'string') return failure(path, 'expected string');
      if (options.minLength !== undefined && input.length < options.minLength) {
        return failure(
          path,
          `expected at least ${options.minLength} characters`,
        );
      }
      if (input.length > options.maxLength) {
        return failure(
          path,
          `expected at most ${options.maxLength} characters`,
        );
      }
      return success(input);
    },
  };
}

export function safeIntegerDecoder(options: {
  minimum: number;
  maximum?: number;
}): Decoder<number> {
  return {
    decode(input, path = []) {
      if (typeof input !== 'number' || !Number.isSafeInteger(input)) {
        return failure(path, 'expected finite safe integer');
      }
      if (input < options.minimum) {
        return failure(path, `expected value >= ${options.minimum}`);
      }
      if (options.maximum !== undefined && input > options.maximum) {
        return failure(path, `expected value <= ${options.maximum}`);
      }
      return success(input);
    },
  };
}

export function literalDecoder<const TValue extends string>(
  expected: TValue,
): Decoder<TValue> {
  return {
    decode(input, path = []) {
      return input === expected
        ? success(expected)
        : failure(path, `expected ${JSON.stringify(expected)}`);
    },
  };
}

export const booleanDecoder: Decoder<boolean> = {
  decode(input, path = []) {
    return typeof input === 'boolean'
      ? success(input)
      : failure(path, 'expected boolean');
  },
};

export function optionalDecoder<TValue>(
  decoder: Decoder<TValue>,
): Decoder<TValue | undefined> {
  return {
    decode(input, path = []) {
      return input === undefined
        ? success(undefined)
        : decoder.decode(input, path);
    },
  };
}

export function nullableDecoder<TValue>(
  decoder: Decoder<TValue>,
): Decoder<TValue | null> {
  return {
    decode(input, path = []) {
      return input === null ? success(null) : decoder.decode(input, path);
    },
  };
}

export function arrayDecoder<TValue>(
  itemDecoder: Decoder<TValue>,
  options: {
    minLength?: number;
    maxLength: number;
    uniqueBy?: (value: TValue) => string | number;
  },
): Decoder<TValue[]> {
  return {
    decode(input, path = []) {
      if (!Array.isArray(input)) return failure(path, 'expected array');
      if (options.minLength !== undefined && input.length < options.minLength) {
        return failure(path, `expected at least ${options.minLength} items`);
      }
      if (input.length > options.maxLength) {
        return failure(path, `expected at most ${options.maxLength} items`);
      }

      const output: TValue[] = [];
      const issues: DecodeIssue[] = [];
      const seen = new Set<string | number>();
      for (const [index, item] of input.entries()) {
        const result = itemDecoder.decode(item, [...path, index]);
        if (!result.ok) {
          issues.push(...result.issues);
          continue;
        }
        if (options.uniqueBy) {
          const key = options.uniqueBy(result.value);
          if (seen.has(key)) {
            issues.push({
              path: [...path, index],
              reason: 'expected unique item',
            });
            continue;
          }
          seen.add(key);
        }
        output.push(result.value);
      }
      return issues.length > 0 ? { ok: false, issues } : success(output);
    },
  };
}

export function objectDecoder<const TShape extends DecoderShape>(
  shape: TShape,
  options: { unknownFields: 'allow' | 'reject' } = {
    unknownFields: 'reject',
  },
): Decoder<InferShape<TShape>> {
  return {
    decode(input, path = []) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) {
        return failure(path, 'expected object');
      }

      const output: Record<string, unknown> = {};
      const issues: DecodeIssue[] = [];
      const knownFields = new Set(Object.keys(shape));
      if (options.unknownFields === 'reject') {
        for (const field of Object.keys(input)) {
          if (!knownFields.has(field)) {
            issues.push({
              path: [...path, field],
              reason: 'unknown field',
            });
          }
        }
      }

      for (const [field, decoder] of Object.entries(shape)) {
        const result = decoder.decode(Reflect.get(input, field), [
          ...path,
          field,
        ]);
        if (result.ok) output[field] = result.value;
        else issues.push(...result.issues);
      }

      if (issues.length > 0) return { ok: false, issues };
      // Every field in TShape was decoded above and unknown fields are either
      // rejected or intentionally discarded at this adapter boundary.
      return success(output as InferShape<TShape>);
    },
  };
}

export function unionDecoder<
  const TDecoders extends readonly Decoder<unknown>[],
>(...decoders: TDecoders): Decoder<InferDecoder<TDecoders[number]>> {
  return {
    decode(input, path = []) {
      const issues: DecodeIssue[] = [];
      for (const decoder of decoders) {
        const result = decoder.decode(input, path);
        if (result.ok) {
          // TDecoders preserves each member type, while iteration exposes the
          // safe common Decoder<unknown> view. Success came from that union.
          return success(result.value as InferDecoder<TDecoders[number]>);
        }
        issues.push(...result.issues);
      }
      return {
        ok: false,
        issues: [
          { path, reason: 'did not match any supported variant' },
          ...issues,
        ],
      };
    },
  };
}

export function transformDecoder<TInput, TOutput>(
  decoder: Decoder<TInput>,
  transform: (value: TInput) => TOutput,
): Decoder<TOutput> {
  return {
    decode(input, path = []) {
      const result = decoder.decode(input, path);
      return result.ok ? success(transform(result.value)) : result;
    },
  };
}

export function refineDecoder<TValue>(
  decoder: Decoder<TValue>,
  predicate: (value: TValue) => boolean,
  reason: string,
): Decoder<TValue> {
  return {
    decode(input, path = []) {
      const result = decoder.decode(input, path);
      if (!result.ok) return result;
      return predicate(result.value)
        ? success(result.value)
        : failure(path, reason);
    },
  };
}
