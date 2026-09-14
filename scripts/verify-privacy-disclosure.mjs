import { resolvePrivacyDisclosure } from '../lib/application/privacy-disclosure.ts';

const resolution = resolvePrivacyDisclosure(process.env);
if (resolution.kind === 'blocked') {
  throw new Error(
    `Privacy disclosure build gate blocked: ${resolution.reason} (${resolution.issues.join('; ')})`,
  );
}
