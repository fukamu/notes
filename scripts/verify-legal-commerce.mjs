import { resolveLegalCommerceDisclosure } from '../lib/application/legal-commerce.ts';

const resolution = resolveLegalCommerceDisclosure(process.env);
if (resolution.kind === 'blocked') {
  throw new Error(
    `Legal commerce build gate blocked: ${resolution.reason} (${resolution.issues.join('; ')})`,
  );
}
