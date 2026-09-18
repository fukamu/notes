import {
  decodeExternalTransmissionManifest,
  externalTransmissionManifest,
} from '../lib/application/external-transmission.ts';

const decoded = decodeExternalTransmissionManifest(
  externalTransmissionManifest,
);
if (decoded.kind === 'invalid') {
  throw new Error(
    `External transmission manifest build gate blocked: ${decoded.issues.join('; ')}`,
  );
}
