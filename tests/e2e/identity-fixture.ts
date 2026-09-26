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
export const e2eFixtureAccountId = '01999c20-9e33-7000-8000-000000000001';
export const e2eFixtureVaultId = '01999c20-9e33-7000-8000-000000000002';
export const e2eFixtureSessionId = '01999c20-9e33-7000-8000-000000000003';
export const e2eFixtureSessionEpoch = '1';
export const e2eFixtureSessionToken = Buffer.alloc(32, 0x41).toString(
  'base64url',
);
export const e2eFixtureCursorHmacKey = Buffer.alloc(32, 0x42).toString(
  'base64url',
);
export const e2eFixtureDeletionHmacKey = Buffer.alloc(32, 0x43).toString(
  'base64url',
);

export function e2eSessionStorageState() {
  return {
    cookies: [
      {
        name: '__Host-fukamu_session',
        value: e2eFixtureSessionToken,
        domain: 'localhost',
        path: '/',
        expires: -1,
        httpOnly: true,
        secure: true,
        sameSite: 'Strict' as const,
      },
    ],
    origins: [],
  };
}

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
