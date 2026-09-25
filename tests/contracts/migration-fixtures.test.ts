import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { decodeOrThrow } from '@/lib/codec/core';
import { accountDeletionIdempotencyKeyDecoder } from '@/lib/application/account-deletion-handoff';
import { createAccountDeletionHttpRemote } from '@/lib/client/http-account-deletion';
import { createBillingUiHttpTransport } from '@/lib/client/http-billing-ui';
import { createPrivacyRequestUiHttpTransport } from '@/lib/client/http-privacy-request';
import { createTermsConsentUiHttpTransport } from '@/lib/client/terms-consent-ui';
import { parseCardId } from '@/lib/domain/id';
import { parseVaultId } from '@/lib/domain/identity';
import {
  emailOtpAddressDecoder,
  emailOtpChallengeIdDecoder,
  emailOtpCodeDecoder,
  emailOtpDigestDecoder,
  emailOtpSaltDecoder,
} from '@/lib/domain/email-otp';
import {
  decodeSyncRequest,
  decodeSyncResponse,
  encodeSyncRequest,
} from '@/lib/sync/protocol';
import {
  decodeSyncV2Request,
  decodeSyncV2Response,
} from '@/lib/sync/v2-protocol';
import { authorizeSession, sessionRecordDecoder } from '@/server/core/session';
import { evaluateCsrfRequest } from '@/server/core/csrf';
import {
  oidcProviderConfigurationDecoder,
  pendingOidcTransactionDecoder,
  validateOidcClaims,
  validateOidcTransaction,
  verifiedOidcClaimsDecoder,
} from '@/server/core/oidc';
import {
  createEmailOtpChallenge,
  resendEmailOtpChallenge,
  verifyEmailOtpChallenge,
} from '@/server/core/email-otp';
import {
  decodeEnvelopeCiphertext,
  parseCryptoObjectRevision,
  parseDekVersion,
  serializeEnvelopeAad,
} from '@/server/crypto/core';
import {
  parsePrivacyRequestId,
  parsePrivacyRequestSubmissionId,
} from '@/server/privacy-request/public';

const fixtureRoot = new URL('../../contracts/fixtures/', import.meta.url);

describe('Go migration shared contract fixtures', () => {
  it('keeps the legacy request encoding and response invariants executable', async () => {
    const fixtureData = record(await fixture('sync/legacy-v1.json'));
    const request = decodeSyncRequest(field(fixtureData, 'request'));
    const response = decodeSyncResponse(
      field(fixtureData, 'response'),
      request.mutations,
    );

    expect(JSON.stringify(encodeSyncRequest(request))).toBe(
      string(field(fixtureData, 'canonicalRequestJson')),
    );
    expect(response.cards).toHaveLength(2);
    expect(response.cards[1]?.body).toEqual([]);
    expect(response.conflicts).toEqual([]);
  });

  it('rejects unsafe or ambiguous legacy request fixtures', async () => {
    const fixtureValue = record(await fixture('sync/rejections.json'));
    const cases = field(fixtureValue, 'cases');
    if (!Array.isArray(cases)) throw new Error('cases must be an array');

    for (const testCase of cases) {
      const candidate = record(testCase);
      expect(
        () => decodeSyncRequest(field(candidate, 'input')),
        string(field(candidate, 'name')),
      ).toThrow();
    }
  });

  it('preserves v2 null cursors and empty arrays separately', async () => {
    const fixtureValue = record(await fixture('sync/v2.json'));
    const request = decodeSyncV2Request(field(fixtureValue, 'request'));
    const response = decodeSyncV2Response(
      field(fixtureValue, 'response'),
      request.mutations,
    );

    expect(request.cursor).toBeNull();
    expect(request.mutations).toEqual([]);
    expect(response.changes).toEqual([]);
    expect(response.receipts).toEqual([]);
    expect(response.highWatermark).toBe(0);
  });

  it('keeps session expiry and CSRF decisions in the pure core', async () => {
    const fixtureValue = record(await fixture('identity/session.json'));
    const active = decodeOrThrow(
      sessionRecordDecoder,
      field(fixtureValue, 'active'),
      'shared session fixture',
    );
    expect(authorizeSession(active, 1_500).kind).toBe('authenticated');
    expect(authorizeSession(active, 2_000)).toEqual({
      kind: 'denied',
      reason: 'expired',
    });
    expect(authorizeSession(active, -1)).toEqual({
      kind: 'denied',
      reason: 'invalid-clock',
    });

    const csrf = record(field(fixtureValue, 'csrf'));
    expect(evaluateCsrfRequest(csrfInput(field(csrf, 'allowed')))).toEqual({
      kind: 'allowed',
      reason: 'same-origin',
    });
    expect(evaluateCsrfRequest(csrfInput(field(csrf, 'denied')))).toEqual({
      kind: 'denied',
      reason: 'origin-mismatch',
    });
  });

  it('keeps OIDC transaction and verified-claim policy executable', async () => {
    const fixtureValue = record(await fixture('identity/oidc.json'));
    const configuration = decodeOrThrow(
      oidcProviderConfigurationDecoder,
      field(fixtureValue, 'configuration'),
      'shared OIDC configuration fixture',
    );
    const transaction = decodeOrThrow(
      pendingOidcTransactionDecoder,
      field(fixtureValue, 'transaction'),
      'shared OIDC transaction fixture',
    );
    const claims = decodeOrThrow(
      verifiedOidcClaimsDecoder,
      field(fixtureValue, 'claims'),
      'shared OIDC claims fixture',
    );
    const now = number(field(fixtureValue, 'nowEpochSeconds'));
    expect(
      validateOidcTransaction(
        transaction,
        transaction.state,
        configuration,
        now,
      ),
    ).toEqual({ kind: 'valid' });
    const expected = record(field(fixtureValue, 'expected'));
    expect(validateOidcClaims(claims, transaction, configuration, now)).toEqual(
      {
        kind: 'valid',
        identityKey: {
          issuer: string(field(expected, 'issuer')),
          subject: string(field(expected, 'subject')),
        },
        email: string(field(expected, 'email')),
      },
    );
  });

  it('keeps Email OTP expiry, one-time verification, and resend invariants executable', async () => {
    const fixtureValue = record(await fixture('identity/email-otp.json'));
    const expected = record(field(fixtureValue, 'expected'));
    const challengeId = decodeOrThrow(
      emailOtpChallengeIdDecoder,
      field(fixtureValue, 'challengeId'),
      'shared Email OTP challenge ID',
    );
    const address = decodeOrThrow(
      emailOtpAddressDecoder,
      field(fixtureValue, 'address'),
      'shared Email OTP address',
    );
    const digest = decodeOrThrow(
      emailOtpDigestDecoder,
      field(fixtureValue, 'digest'),
      'shared Email OTP digest',
    );
    const salt = decodeOrThrow(
      emailOtpSaltDecoder,
      field(fixtureValue, 'salt'),
      'shared Email OTP salt',
    );
    const code = decodeOrThrow(
      emailOtpCodeDecoder,
      field(fixtureValue, 'code'),
      'shared Email OTP code',
    );
    expect(code).toBe('12345678');
    const created = createEmailOtpChallenge({
      challengeId,
      address,
      digest,
      salt,
      purpose: { kind: 'sign-in' },
      nowEpochSeconds: number(field(fixtureValue, 'createdAtEpochSeconds')),
    });
    expect(created.kind).toBe('created');
    if (created.kind !== 'created') return;
    expect(created.challenge).toMatchObject({
      address: string(field(expected, 'canonicalAddress')),
      expiresAtEpochSeconds: number(field(expected, 'expiresAtEpochSeconds')),
      failedAttempts: number(field(expected, 'failedAttempts')),
      sendCount: number(field(expected, 'sendCount')),
      version: number(field(expected, 'version')),
    });
    expect(
      verifyEmailOtpChallenge({
        challenge: created.challenge,
        digestMatches: true,
        nowEpochSeconds: number(field(fixtureValue, 'verifyAtEpochSeconds')),
      }),
    ).toMatchObject({ kind: 'verified', challenge: { kind: 'consumed' } });
    expect(
      resendEmailOtpChallenge({
        challenge: created.challenge,
        digest,
        salt,
        nowEpochSeconds: number(field(fixtureValue, 'resendAtEpochSeconds')),
      }),
    ).toMatchObject({
      kind: 'resent',
      challenge: {
        expiresAtEpochSeconds: number(field(expected, 'expiresAtEpochSeconds')),
        failedAttempts: 0,
        sendCount: 2,
      },
    });
  });

  it('fixes the envelope format and canonical AAD byte source', async () => {
    const fixtureValue = record(await fixture('crypto/envelope.json'));
    expect(decodeEnvelopeCiphertext(field(fixtureValue, 'ciphertext'))).toEqual(
      field(fixtureValue, 'ciphertext'),
    );
    expect(() =>
      decodeEnvelopeCiphertext(field(fixtureValue, 'tampered')),
    ).toThrow();

    const aad = record(field(fixtureValue, 'aad'));
    expect(
      serializeEnvelopeAad({
        context: {
          vaultId: parseVaultId(field(aad, 'vaultId')),
          object: {
            kind: 'card',
            objectId: parseCardId(field(aad, 'objectId')),
          },
          objectRevision: parseCryptoObjectRevision(
            field(aad, 'objectRevision'),
          ),
        },
        dekVersion: parseDekVersion(field(aad, 'dekVersion')),
      }),
    ).toBe(string(field(aad, 'canonical')));
  });

  it('passes billing fixtures through the current browser decoder', async () => {
    const fixtureValue = record(await fixture('billing/checkout.json'));
    const transport = createBillingUiHttpTransport(async () =>
      Response.json({
        offer: field(fixtureValue, 'offer'),
        offerHash: field(fixtureValue, 'offerHash'),
      }),
    );

    await expect(transport.loadOffer()).resolves.toMatchObject({
      kind: 'available',
      offerHash: field(fixtureValue, 'offerHash'),
      offer: { serviceName: 'FUKAMU Notes', trialDays: 14 },
    });
    expect(field(fixtureValue, 'dependency')).toBe('issue-403-pr-404');
  });

  it('keeps deletion terminal fields and privacy ownership data strict', async () => {
    const fixtureValue = record(await fixture('account/lifecycle.json'));
    const deletion = record(field(fixtureValue, 'deletion'));
    const idempotencyKey = decodeOrThrow(
      accountDeletionIdempotencyKeyDecoder,
      'I'.repeat(43),
      'shared deletion fixture key',
    );
    const accepted = createAccountDeletionHttpRemote(async () =>
      Response.json(field(deletion, 'inProgress')),
    );
    await expect(accepted.start({ idempotencyKey })).resolves.toMatchObject({
      kind: 'accepted',
      status: { kind: 'in-progress' },
    });
    const rejected = createAccountDeletionHttpRemote(async () =>
      Response.json(field(deletion, 'invalidTerminal')),
    );
    await expect(rejected.start({ idempotencyKey })).resolves.toEqual({
      kind: 'rejected',
      reason: 'remote-unavailable',
    });

    const privacy = record(field(fixtureValue, 'privacy'));
    const pending = record(field(privacy, 'pending'));
    const command = {
      submissionId: parsePrivacyRequestSubmissionId(
        '01991f20-61d2-7000-8000-000000002101',
      ),
      requestKind: 'disclosure' as const,
    };
    const validPrivacy = createPrivacyRequestUiHttpTransport(async () =>
      Response.json(field(privacy, 'pending')),
    );
    await expect(validPrivacy.submit(command)).resolves.toMatchObject({
      kind: 'accepted',
      request: {
        requestId: parsePrivacyRequestId(field(pending, 'requestId')),
        status: 'verification-pending',
      },
    });
    const invalidPrivacy = createPrivacyRequestUiHttpTransport(async () =>
      Response.json(field(privacy, 'invalid')),
    );
    await expect(invalidPrivacy.submit(command)).resolves.toEqual({
      kind: 'rejected',
      reason: 'unavailable',
    });
  });

  it('decodes the shared terms status through the browser boundary', async () => {
    const fixtureValue = record(await fixture('account/lifecycle.json'));
    const terms = record(field(fixtureValue, 'terms'));
    const transport = createTermsConsentUiHttpTransport(async () =>
      Response.json(field(terms, 'status')),
    );
    await expect(transport.loadStatus()).resolves.toMatchObject({
      kind: 'available',
      status: { kind: 'current', acceptanceRequired: true },
    });
  });
});

async function fixture(path: string): Promise<unknown> {
  const source = await readFile(new URL(path, fixtureRoot), 'utf8');
  const value: unknown = JSON.parse(source);
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error('expected fixture object');
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function field(value: Record<string, unknown>, name: string): unknown {
  if (!Object.hasOwn(value, name)) throw new Error(`missing fixture ${name}`);
  return value[name];
}

function string(value: unknown): string {
  if (typeof value !== 'string') throw new Error('expected fixture string');
  return value;
}

function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error('expected fixture safe integer');
  }
  return value;
}

function csrfInput(value: unknown) {
  const input = record(value);
  return {
    method: field(input, 'method'),
    expectedOrigin: field(input, 'expectedOrigin'),
    originHeader: field(input, 'originHeader'),
    secFetchSiteHeader: field(input, 'secFetchSiteHeader'),
  };
}
