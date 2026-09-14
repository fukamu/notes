import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  out: './drizzle',
  schema: [
    './db/schema.ts',
    './server/account-deletion/d1-schema.ts',
    './server/billing/d1-schema.ts',
    './server/control-plane/d1-schema.ts',
    './server/crypto/d1-schema.ts',
    './server/encrypted-object/d1-schema.ts',
    './server/entitlement/d1-schema.ts',
    './server/quota/d1-schema.ts',
    './server/vault-content/d1-schema.ts',
    './server/vault-content/sync-v2-d1-schema.ts',
  ],
  dialect: 'sqlite',
});
