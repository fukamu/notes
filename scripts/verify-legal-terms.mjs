import {
  evaluateLegalTermsConsistency,
  resolveLegalTermsDisclosure,
} from '../lib/application/legal-terms.ts';
import { resolveLegalCommerceDisclosure } from '../lib/application/legal-commerce.ts';
import { resolvePrivacyDisclosure } from '../lib/application/privacy-disclosure.ts';

const terms = resolveLegalTermsDisclosure(process.env);
if (terms.kind === 'blocked') {
  throw new Error(
    `Legal terms build gate blocked: ${terms.reason} (${terms.issues.join('; ')})`,
  );
}
const commerce = resolveLegalCommerceDisclosure(process.env);
if (commerce.kind === 'blocked') {
  throw new Error(
    `Legal terms consistency gate blocked by commerce: ${commerce.reason}`,
  );
}
const privacy = resolvePrivacyDisclosure(process.env);
if (privacy.kind === 'blocked') {
  throw new Error(
    `Legal terms consistency gate blocked by privacy: ${privacy.reason}`,
  );
}
const consistency = evaluateLegalTermsConsistency(
  terms.disclosure,
  commerce.disclosure,
  privacy.disclosure,
);
if (consistency.kind === 'inconsistent') {
  throw new Error(
    `Legal terms consistency gate blocked: ${consistency.issues.join('; ')}`,
  );
}
