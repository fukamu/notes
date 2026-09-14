import { resolvePrivacyDisclosure } from '../lib/application/privacy-disclosure.ts';
import {
  evaluatePrivacyProcessingConsistency,
  resolvePrivacyProcessingRegistry,
} from '../lib/application/privacy-processing-registry.ts';

const disclosure = resolvePrivacyDisclosure(process.env);
if (disclosure.kind === 'blocked') {
  throw new Error(
    `Privacy processing build gate blocked by disclosure: ${disclosure.reason} (${disclosure.issues.join('; ')})`,
  );
}
const registry = resolvePrivacyProcessingRegistry(process.env);
if (registry.kind === 'blocked') {
  throw new Error(
    `Privacy processing build gate blocked by registry: ${registry.reason} (${registry.issues.join('; ')})`,
  );
}
const consistency = evaluatePrivacyProcessingConsistency({
  disclosure: disclosure.disclosure,
  registry: registry.registry,
});
if (consistency.kind === 'inconsistent') {
  throw new Error(
    `Privacy processing build gate found drift: ${consistency.issues.join('; ')}`,
  );
}
