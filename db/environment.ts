export const D1_BINDING_NAME = 'DB' as const;

export class ConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigurationError';
  }
}

function isD1Database(value: unknown): value is D1Database {
  if (!value || typeof value !== 'object') return false;
  return (
    typeof Reflect.get(value, 'prepare') === 'function' &&
    typeof Reflect.get(value, 'batch') === 'function' &&
    typeof Reflect.get(value, 'exec') === 'function'
  );
}

export function getD1Binding(environment: unknown): D1Database {
  if (!environment || typeof environment !== 'object') {
    throw new ConfigurationError('Cloudflare environment is unavailable');
  }
  const binding: unknown = Reflect.get(environment, D1_BINDING_NAME);
  if (!isD1Database(binding)) {
    throw new ConfigurationError(
      `Cloudflare D1 binding \`${D1_BINDING_NAME}\` is unavailable or invalid`,
    );
  }
  return binding;
}
