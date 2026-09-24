/// <reference types="vite/client" />

export function buildRuntimeMode(): unknown {
  // Vite replaces this direct access at build time. Do not read it through
  // reflection: Wrangler dev would then report its own mode and accidentally
  // bypass a production-built smoke test.
  return import.meta.env.MODE;
}
