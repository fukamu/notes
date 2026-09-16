/// <reference types="@cloudflare/workers-types" />

// Cloudflare exposes D1Database as a runtime-global type. Re-exporting the
// binding shape gives server-side D1 adapters an explicit dependency while
// keeping their public application contracts provider-neutral.
export type D1DatabaseBinding = D1Database;
