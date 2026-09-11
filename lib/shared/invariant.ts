export function invariant<T>(
  value: T,
  message: string,
): asserts value is NonNullable<T> {
  if (value === undefined || value === null) throw new Error(message);
}

export function assertNever(_value: never, message: string): never {
  throw new Error(message);
}
