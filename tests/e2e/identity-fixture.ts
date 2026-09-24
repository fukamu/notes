import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
} from 'node:crypto';

export const localAssertionHeader = 'X-Fukamu-Local-Identity-Assertion';
export const e2eIssuer = 'https://issuer.test';
export const e2eAudience = 'notes-e2e';
export const e2eOwnerSubject = 'fukamu-notes-e2e-user';

const privateKeyEnvironment = 'FUKAMU_E2E_LOCAL_AUTH_PRIVATE_KEY';

export function configureE2EIdentity(): Readonly<{
  publicKey: string;
  ownerAssertion: string;
}> {
  if (!process.env[privateKeyEnvironment]) {
    const { privateKey } = generateKeyPairSync('ed25519');
    process.env[privateKeyEnvironment] = privateKey
      .export({ format: 'der', type: 'pkcs8' })
      .toString('base64url');
  }
  const privateKey = privateKeyFromEnvironment();
  const publicDer = createPublicKey(privateKey).export({
    format: 'der',
    type: 'spki',
  });
  return {
    publicKey: publicDer.subarray(publicDer.length - 32).toString('base64url'),
    ownerAssertion: assertionForSubject(e2eOwnerSubject),
  };
}

export function assertionForSubject(subject: string): string {
  if (!/^[\u0021-\u007e]{1,256}$/.test(subject)) {
    throw new Error('E2E identity subject is invalid');
  }
  const now = Math.floor(Date.now() / 1000);
  const header = encodeJson({ alg: 'EdDSA', typ: 'JWT' });
  const payload = encodeJson({
    iss: e2eIssuer,
    aud: e2eAudience,
    sub: subject,
    iat: now - 5,
    exp: now + 9 * 60,
  });
  const unsigned = `${header}.${payload}`;
  const signature = sign(
    null,
    Buffer.from(unsigned),
    privateKeyFromEnvironment(),
  );
  return `${unsigned}.${signature.toString('base64url')}`;
}

function privateKeyFromEnvironment() {
  const encoded = process.env[privateKeyEnvironment];
  if (!encoded) throw new Error('E2E identity has not been configured');
  return createPrivateKey({
    key: Buffer.from(encoded, 'base64url'),
    format: 'der',
    type: 'pkcs8',
  });
}

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}
