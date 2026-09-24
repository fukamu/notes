declare const __FUKAMU_PUBLIC_ENV__: unknown;

export function currentPublicBuildEnvironment(): unknown {
  return typeof __FUKAMU_PUBLIC_ENV__ === 'undefined'
    ? {}
    : __FUKAMU_PUBLIC_ENV__;
}

export function publicBuildEnvironmentValue(key: string): unknown {
  const environment = currentPublicBuildEnvironment();
  return environment !== null && typeof environment === 'object'
    ? Reflect.get(environment, key)
    : undefined;
}
