import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  out: './drizzle',
  schema: ['./db/schema.ts', './server/control-plane/d1-schema.ts'],
  dialect: 'sqlite',
});
