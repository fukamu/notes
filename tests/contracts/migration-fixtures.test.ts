import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decodeOrThrow } from '@/lib/codec/core';
import { accountDeletionIdempotencyKeyDecoder } from '@/lib/application/account-deletion-handoff';
import { createAccountDeletionHttpRemote } from '@/lib/client/http-account-deletion';
import { createBillingUiHttpTransport } from '@/lib/client/http-billing-ui';
import { createPrivacyRequestUiHttpTransport } from '@/lib/client/http-privacy-request';
import { createTermsConsentUiHttpTransport } from '@/lib/client/terms-consent-ui';
import { decodeLegalTermsDisclosure } from '@/lib/application/legal-terms';
import { decodeLegalCommerceDisclosure } from '@/lib/application/legal-commerce';
import { parseCardId } from '@/lib/domain/id';
import {
  parseAccountId,
  parseSessionEpoch,
  parseSessionId,
  parseVaultId,
} from '@/lib/domain/identity';
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
import { createGcpCloudKmsKeyManagement } from '@/server/adapters/gcp-cloud-kms';
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
import { createDataEncryptionKey } from '@/server/crypto/key-material';
import { webCryptoAes256Gcm } from '@/server/crypto/web-aes-gcm';
import {
  parsePrivacyRequestId,
  parsePrivacyRequestSubmissionId,
  privacyRequestKindDecoder,
} from '@/server/privacy-request/public';
import {
  completeVaultRecoveryDrill,
  decodeVaultRecoveryManifest,
  planVaultRecoveryDrill,
} from '@/server/encrypted-object/recovery-core';
import {
  planCheckoutCreation,
  planReconciliationSnapshot,
  planVerifiedProviderFact,
  type BillingSubscriptionRecord,
} from '@/server/billing/core';
import {
  billingVersionDecoder,
  parseBillingProvider,
  parseBillingSubscriptionId,
  parseCheckoutIntentId,
  parseProviderCustomerReference,
  parseProviderEventId,
  parseProviderInvoiceReference,
  parseProviderSubscriptionReference,
  parseReconciliationSnapshotId,
  type ReconciliationSnapshot,
  type VerifiedProviderFact,
} from '@/server/billing/public';
import {
  contractOfferSnapshotDecoder,
  parseContractEvidenceId,
  parseContractOfferHash,
  parseContractSubmissionId,
} from '@/server/legal-checkout/public';
import {
  planContractEvidence,
  planContractOffer,
  serializeContractOffer,
} from '@/server/legal-checkout/core';
import {
  decodeStripeEventPlan,
  planStripeCheckout,
} from '@/server/stripe/core';
import {
  parseStripeBillingConfiguration,
  parseStripeWebhookSecret,
} from '@/server/stripe/public';
import { createWebCryptoStripeWebhookVerifier } from '@/server/stripe/webhook-signature';
import {
  authorizeOfflineLease,
  evaluateSubscriptionFacts,
  planEntitlementProjection,
  planOfflineLease,
} from '@/server/entitlement/core';
import {
  paidPersonalVaultLimits,
  parseOfflineLeaseDuration,
  parseOfflineLeaseId,
} from '@/server/entitlement/public';
import { decideTermsConsentStatus } from '@/server/terms-consent/application-core';
import {
  planTermsConsent,
  planTermsConsentSnapshot,
  serializeTermsDisclosure,
} from '@/server/terms-consent/core';
import {
  parseTermsConsentId,
  parseTermsConsentSubmissionId,
  parseTermsDocumentHash,
} from '@/server/terms-consent/public';

const fixtureRoot = new URL('../../contracts/fixtures/', import.meta.url);

describe('Go migration shared contract fixtures', () => {
  it('keeps commercial offer bytes, evidence, and checkout identifiers compatible', async () => {
    const fixtureValue = record(await fixture('legal/contract-evidence.json'));
    const expected = record(field(fixtureValue, 'expected'));
    const decoded = decodeLegalCommerceDisclosure(
      field(fixtureValue, 'disclosure'),
    );
    if (decoded.kind !== 'decoded') {
      throw new Error(`invalid commerce fixture: ${decoded.issues.join(', ')}`);
    }
    const offer = planContractOffer(decoded.disclosure);
    if (offer.kind !== 'ready') throw new Error('invalid contract offer');
    const serialized = serializeContractOffer(offer.offer);
    const offerHash = parseContractOfferHash(
      `sha256:${createHash('sha256').update(serialized).digest('hex')}`,
    );
    expect(offerHash).toBe(field(expected, 'canonicalSha256'));
    expect(offer.offer).toMatchObject({
      offerVersion: field(expected, 'offerVersion'),
      annualEstimateYen: number(field(expected, 'annualEstimateYen')),
    });
    expect(serialized).toContain('<標準> & 個人');
    expect(serialized).toContain('\u2028');
    expect(serialized).not.toMatch(/\\u(?:003c|003e|0026|2028|2029)/);

    const scopeValue = record(field(fixtureValue, 'scope'));
    const submissionId = parseContractSubmissionId(
      field(fixtureValue, 'submissionId'),
    );
    const evidence = planContractEvidence({
      context: {
        accountId: parseAccountId(field(scopeValue, 'accountId')),
        vaultId: parseVaultId(field(scopeValue, 'vaultId')),
        sessionId: parseSessionId('01991f20-61d2-7000-8000-000000000301'),
        sessionEpoch: parseSessionEpoch(1),
      },
      command: {
        submissionId,
        presentedOfferHash: offerHash,
        consent: { kind: 'affirmed' },
      },
      offer: offer.offer,
      serializedOffer: serialized,
      authoritativeOfferHash: offerHash,
      evidenceId: parseContractEvidenceId(field(fixtureValue, 'evidenceId')),
      confirmedAt: number(field(fixtureValue, 'confirmedAt')),
      existing: undefined,
    });
    expect(evidence.kind).toBe(field(expected, 'evidencePlan'));
    expect(evidence).toMatchObject({
      record: {
        evidenceId: field(expected, 'checkoutSubscriptionId'),
        submissionId: field(expected, 'checkoutIntentId'),
      },
    });
  });

  it('keeps terms consent serialization and decisions compatible', async () => {
    const fixtureValue = record(await fixture('legal/terms-consent.json'));
    const expected = record(field(fixtureValue, 'expected'));
    const decoded = decodeLegalTermsDisclosure(
      field(fixtureValue, 'disclosure'),
    );
    if (decoded.kind !== 'decoded') {
      throw new Error(`invalid terms fixture: ${decoded.issues.join(', ')}`);
    }
    const serialized = serializeTermsDisclosure(decoded.disclosure);
    const termsHash = parseTermsDocumentHash(
      `sha256:${createHash('sha256').update(serialized).digest('hex')}`,
    );
    expect(termsHash).toBe(field(expected, 'canonicalSha256'));

    const snapshot = planTermsConsentSnapshot({
      disclosure: decoded.disclosure,
      termsHash,
    });
    if (snapshot.kind !== 'ready') throw new Error('invalid terms snapshot');
    const scopeValue = record(field(fixtureValue, 'scope'));
    const scope = {
      accountId: parseAccountId(field(scopeValue, 'accountId')),
      vaultId: parseVaultId(field(scopeValue, 'vaultId')),
    };
    const consent = planTermsConsent({
      context: scope,
      command: {
        submissionId: parseTermsConsentSubmissionId(
          field(fixtureValue, 'submissionId'),
        ),
        presentedTermsVersion: snapshot.snapshot.termsVersion,
        presentedTermsHash: snapshot.snapshot.termsHash,
        consent: { kind: 'affirmed' },
      },
      snapshot: snapshot.snapshot,
      consentId: parseTermsConsentId(field(fixtureValue, 'consentId')),
      acceptedAt: number(field(fixtureValue, 'acceptedAt')),
      existing: undefined,
    });
    expect(consent.kind).toBe(field(expected, 'consentPlan'));
    if (consent.kind !== 'append') throw new Error('terms consent rejected');

    expect(
      decideTermsConsentStatus({
        context: scope,
        current: snapshot.snapshot,
        latest: undefined,
        acceptancePolicy: { kind: 'initial-release' },
      }),
    ).toMatchObject({
      kind: 'resolved',
      status: { kind: field(expected, 'initialStatus') },
    });
    expect(
      decideTermsConsentStatus({
        context: scope,
        current: snapshot.snapshot,
        latest: consent.record,
        acceptancePolicy: { kind: 'initial-release' },
      }),
    ).toMatchObject({
      kind: 'resolved',
      status: { kind: field(expected, 'acceptedStatus') },
    });
  });

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
    const ciphertext = decodeEnvelopeCiphertext(
      field(fixtureValue, 'ciphertext'),
    );
    expect(ciphertext).toEqual(field(fixtureValue, 'ciphertext'));
    expect(() =>
      decodeEnvelopeCiphertext(field(fixtureValue, 'tampered')),
    ).toThrow();

    const aad = record(field(fixtureValue, 'aad'));
    const canonicalAad = serializeEnvelopeAad({
      context: {
        vaultId: parseVaultId(field(aad, 'vaultId')),
        object: {
          kind: 'card',
          objectId: parseCardId(field(aad, 'objectId')),
        },
        objectRevision: parseCryptoObjectRevision(field(aad, 'objectRevision')),
      },
      dekVersion: parseDekVersion(field(aad, 'dekVersion')),
    });
    expect(canonicalAad).toBe(string(field(aad, 'canonical')));

    const key = createDataEncryptionKey(
      base64UrlBytes(string(field(fixtureValue, 'keyBase64Url'))),
    );
    const plaintext = base64UrlBytes(
      string(field(fixtureValue, 'plaintextBase64Url')),
    );
    try {
      await expect(
        webCryptoAes256Gcm.seal({
          key,
          nonce: ciphertext.nonce,
          aad: canonicalAad,
          plaintext,
        }),
      ).resolves.toBe(ciphertext.sealedPayload);
      await expect(
        webCryptoAes256Gcm.open({
          key,
          nonce: ciphertext.nonce,
          aad: canonicalAad,
          sealedPayload: ciphertext.sealedPayload,
        }),
      ).resolves.toEqual(plaintext);
    } finally {
      key.destroy();
    }

    const wrappedAad = record(field(fixtureValue, 'wrappedDekAad'));
    let observedWrappedAad: string | undefined;
    const kms = createGcpCloudKmsKeyManagement({
      cryptoKeyVersionResource: field(wrappedAad, 'keyVersionName'),
      transport: {
        async encrypt(command) {
          observedWrappedAad = new TextDecoder().decode(
            base64Bytes(command.additionalAuthenticatedData),
          );
          throw new Error('fixture transport stops after observing AAD');
        },
        async decrypt() {
          throw new Error('unexpected decrypt');
        },
      },
      entropy: {
        async createDataKeyBytes() {
          return base64UrlBytes(string(field(fixtureValue, 'keyBase64Url')));
        },
      },
      clock: { now: () => 1_725_000_000_000 },
    });
    await expect(
      kms.generateDataKey({
        vaultId: parseVaultId(field(wrappedAad, 'vaultId')),
        dekVersion: parseDekVersion(field(wrappedAad, 'dekVersion')),
      }),
    ).rejects.toThrow('GCP Cloud KMS operation failed');
    expect(observedWrappedAad).toBe(string(field(wrappedAad, 'canonical')));
  });

  it('keeps the Vault recovery manifest and receipt decisions compatible', async () => {
    const fixtureValue = record(await fixture('crypto/vault-recovery.json'));
    const manifest = decodeVaultRecoveryManifest(
      field(fixtureValue, 'manifest'),
    );
    const drilledAt = number(field(fixtureValue, 'drilledAt'));
    expect(
      planVaultRecoveryDrill({
        scope: {
          accountId: manifest.accountId,
          vaultId: manifest.vaultId,
        },
        manifest,
        drilledAt,
      }),
    ).toEqual({ kind: 'accepted' });
    const completion = completeVaultRecoveryDrill({
      manifest,
      drilledAt,
      verifiedObjects: manifest.objects.length,
      verifiedVersions: manifest.objects.map((object) => object.dekVersion),
    });
    expect(completion).toMatchObject({
      kind: 'verified',
      receipt: field(fixtureValue, 'expected'),
    });
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

  it('keeps Stripe Checkout planning and signed webhook decoding compatible', async () => {
    const fixtureValue = record(await fixture('billing/stripe.json'));
    const configuration = parseStripeBillingConfiguration(
      field(fixtureValue, 'configuration'),
    );
    const commandValue = record(field(fixtureValue, 'command'));
    const contractValue = record(field(commandValue, 'contract'));
    const command = {
      subscriptionId: parseBillingSubscriptionId(
        field(commandValue, 'subscriptionId'),
      ),
      checkoutIntentId: parseCheckoutIntentId(
        field(commandValue, 'checkoutIntentId'),
      ),
      createdAt: number(field(commandValue, 'createdAt')),
      contract: {
        evidenceId: parseContractEvidenceId(field(contractValue, 'evidenceId')),
        offerHash: parseContractOfferHash(field(contractValue, 'offerHash')),
        offer: decodeOrThrow(
          contractOfferSnapshotDecoder,
          field(contractValue, 'offer'),
          'shared Stripe contract offer',
        ),
      },
    };
    const expectedCheckout = record(field(fixtureValue, 'expectedCheckout'));
    const checkout = planStripeCheckout(configuration, command);
    expect(checkout.idempotencyKey).toBe(
      string(field(expectedCheckout, 'idempotencyKey')),
    );
    expect(Object.fromEntries(checkout.fields)).toEqual(
      field(expectedCheckout, 'fields'),
    );

    const webhook = record(field(fixtureValue, 'webhook'));
    const rawBody = new TextEncoder().encode(string(field(webhook, 'rawBody')));
    const verifier = createWebCryptoStripeWebhookVerifier(
      parseStripeWebhookSecret(field(webhook, 'secret')),
    );
    await expect(
      verifier.verify({
        rawBody,
        signatureHeader: field(webhook, 'signatureHeader'),
        receivedAt: number(field(webhook, 'receivedAt')),
      }),
    ).resolves.toEqual({ kind: 'verified', rawBody });
    const event = decodeStripeEventPlan(
      JSON.parse(new TextDecoder().decode(rawBody)),
      {
        mode: configuration.mode,
        apiVersion: configuration.apiVersion,
        receivedAt: number(field(webhook, 'receivedAt')),
      },
    );
    expect(event.kind).toBe('fact');
    if (event.kind !== 'fact') throw new Error('fixture event was not a fact');
    expect(event.fact).toMatchObject(record(field(webhook, 'expected')));
  });

  it('keeps billing fact ordering and same-time reconciliation compatible', async () => {
    const fixtureValue = record(await fixture('billing/projection.json'));
    const owner = record(field(fixtureValue, 'owner'));
    const commandValue = record(field(fixtureValue, 'command'));
    const mapping = record(field(fixtureValue, 'providerMapping'));
    const context = {
      accountId: parseAccountId(field(owner, 'accountId')),
      vaultId: parseVaultId(field(owner, 'vaultId')),
      sessionId: parseSessionId('01991f20-61d2-7000-8000-000000000301'),
      sessionEpoch: parseSessionEpoch(1),
    };
    const command = {
      subscriptionId: parseBillingSubscriptionId(
        field(commandValue, 'subscriptionId'),
      ),
      checkoutIntentId: parseCheckoutIntentId(
        field(commandValue, 'checkoutIntentId'),
      ),
      provider: parseBillingProvider(field(commandValue, 'provider')),
      createdAt: number(field(commandValue, 'createdAt')),
    };
    const checkout = planCheckoutCreation(context, command);
    if (checkout.kind !== 'create')
      throw new Error('fixture checkout rejected');
    let current: BillingSubscriptionRecord = checkout.record;

    const facts = field(fixtureValue, 'facts');
    if (!Array.isArray(facts)) throw new Error('facts must be an array');
    for (const value of facts) {
      const plan = planVerifiedProviderFact(
        current,
        billingFact(record(value), command, mapping),
      );
      if (plan.kind !== 'apply') throw new Error('fixture fact rejected');
      current = plan.record;
    }

    const snapshots = field(fixtureValue, 'snapshots');
    if (!Array.isArray(snapshots)) {
      throw new Error('snapshots must be an array');
    }
    for (const value of snapshots) {
      const plan = planReconciliationSnapshot(
        current,
        billingSnapshot(record(value), command, mapping),
      );
      if (plan.kind !== 'apply') throw new Error('fixture snapshot rejected');
      current = plan.record;
    }

    const expected = record(field(fixtureValue, 'expected'));
    expect(current).toMatchObject({
      version: number(field(expected, 'version')),
      lifecycle: {
        kind: string(field(expected, 'lifecycle')),
        reason: string(field(expected, 'delinquencyReason')),
      },
      lastPaidAt: number(field(expected, 'lastPaidAt')),
      lastDelinquencyAt: number(field(expected, 'lastDelinquencyAt')),
      lastReconciledAt: number(field(expected, 'lastReconciledAt')),
    });
  });

  it('keeps entitlement projection and the exclusive offline lease boundary compatible', async () => {
    const fixtureValue = record(await fixture('billing/entitlement.json'));
    const contextValue = record(field(fixtureValue, 'context'));
    const factsValue = record(field(fixtureValue, 'facts'));
    const lifecycleValue = record(field(factsValue, 'lifecycle'));
    const leaseValue = record(field(fixtureValue, 'lease'));
    const expected = record(field(fixtureValue, 'expected'));
    const context = {
      accountId: parseAccountId(field(contextValue, 'accountId')),
      vaultId: parseVaultId(field(contextValue, 'vaultId')),
      sessionId: parseSessionId(field(contextValue, 'sessionId')),
      sessionEpoch: parseSessionEpoch(field(contextValue, 'sessionEpoch')),
    };
    const lifecycleKind = string(field(lifecycleValue, 'kind'));
    if (lifecycleKind !== 'trialing') {
      throw new Error('shared entitlement lifecycle must be trialing');
    }
    const facts = {
      subscriptionId: parseBillingSubscriptionId(
        field(factsValue, 'subscriptionId'),
      ),
      accountId: context.accountId,
      vaultId: context.vaultId,
      version: decodeOrThrow(
        billingVersionDecoder,
        field(factsValue, 'version'),
        'shared entitlement billing version',
      ),
      lifecycle: {
        kind: lifecycleKind,
        trialStartedAt: number(field(lifecycleValue, 'trialStartedAt')),
        trialEndsAt: number(field(lifecycleValue, 'trialEndsAt')),
      },
      paymentMethodReady: field(factsValue, 'paymentMethodReady') === true,
      cancelAt:
        field(factsValue, 'cancelAt') === null
          ? null
          : number(field(factsValue, 'cancelAt')),
      updatedAt: number(field(factsValue, 'updatedAt')),
    } as const;
    const checkedAt = number(field(fixtureValue, 'projectionCheckedAt'));
    const evaluation = evaluateSubscriptionFacts(facts, checkedAt);
    expect(evaluation).toEqual({
      kind: 'evaluated',
      state: {
        kind: string(field(expected, 'state')),
        validUntil: number(field(expected, 'validUntil')),
      },
    });
    if (evaluation.kind !== 'evaluated') {
      throw new Error('shared entitlement facts were invalid');
    }
    const projection = planEntitlementProjection(
      context,
      facts,
      evaluation.state,
      checkedAt,
      undefined,
    );
    expect(projection).toMatchObject({
      kind: 'commit',
      record: { version: number(field(expected, 'projectionVersion')) },
    });
    if (projection.kind !== 'commit') {
      throw new Error('shared entitlement projection was not committed');
    }
    const lease = planOfflineLease(
      context,
      projection.record,
      {
        kind: 'configured',
        duration: parseOfflineLeaseDuration(
          field(leaseValue, 'policyDuration'),
        ),
      },
      {
        leaseId: parseOfflineLeaseId(field(leaseValue, 'leaseId')),
        issuedAt: number(field(leaseValue, 'issuedAt')),
      },
    );
    expect(lease).toMatchObject({
      kind: 'issue',
      lease: {
        basis: string(field(expected, 'leaseBasis')),
        expiresAt: number(field(expected, 'leaseExpiresAt')),
      },
    });
    if (lease.kind !== 'issue') {
      throw new Error('shared entitlement lease was not issued');
    }
    expect(
      authorizeOfflineLease(
        lease.lease,
        context,
        'notes-read',
        lease.lease.expiresAt,
      ),
    ).toMatchObject({
      kind: 'denied',
      reason: string(field(expected, 'expiryReason')),
    });
    expect(paidPersonalVaultLimits).toEqual(field(expected, 'limits'));
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
    for (const [fixtureName, statusKind] of [
      ['retryWait', 'retry-wait'],
      ['failed', 'failed'],
      ['terminal', 'completed'],
    ] as const) {
      const remote = createAccountDeletionHttpRemote(async () =>
        Response.json(field(deletion, fixtureName)),
      );
      await expect(remote.start({ idempotencyKey })).resolves.toMatchObject({
        kind: 'accepted',
        status: { kind: statusKind },
      });
    }
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

    const publicStatuses = field(privacy, 'publicStatuses');
    if (!Array.isArray(publicStatuses)) {
      throw new Error('privacy publicStatuses must be an array');
    }
    for (const candidate of publicStatuses) {
      const candidateRecord = record(candidate);
      const requestKind = decodeOrThrow(
        privacyRequestKindDecoder,
        field(candidateRecord, 'requestKind'),
        'shared privacy request kind',
      );
      const transport = createPrivacyRequestUiHttpTransport(async () =>
        Response.json(candidate),
      );
      await expect(
        transport.submit({
          submissionId: command.submissionId,
          requestKind,
        }),
      ).resolves.toMatchObject({
        kind: 'accepted',
        request: { requestKind },
      });
    }
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

function billingFact(
  value: Record<string, unknown>,
  command: Parameters<typeof planCheckoutCreation>[1],
  mapping: Record<string, unknown>,
): VerifiedProviderFact {
  const base = {
    subscriptionId: command.subscriptionId,
    provider: command.provider,
    eventId: parseProviderEventId(field(value, 'eventId')),
    providerCustomerReference: parseProviderCustomerReference(
      field(mapping, 'customerReference'),
    ),
    providerSubscriptionReference: parseProviderSubscriptionReference(
      field(mapping, 'subscriptionReference'),
    ),
    occurredAt: number(field(value, 'occurredAt')),
    recordedAt: number(field(value, 'recordedAt')),
  };
  switch (string(field(value, 'kind'))) {
    case 'trial-started':
      return {
        ...base,
        kind: 'trial-started',
        trialStartedAt: number(field(value, 'trialStartedAt')),
        trialEndsAt: number(field(value, 'trialEndsAt')),
      };
    case 'payment-method-updated':
      return { ...base, kind: 'payment-method-updated' };
    case 'invoice-paid':
      return {
        ...base,
        kind: 'invoice-paid',
        invoiceReference: parseProviderInvoiceReference(
          field(value, 'invoiceReference'),
        ),
        paidPeriodStartedAt: number(field(value, 'paidPeriodStartedAt')),
        paidPeriodEndsAt: number(field(value, 'paidPeriodEndsAt')),
      };
    case 'invoice-payment-failed':
      return {
        ...base,
        kind: 'invoice-payment-failed',
        invoiceReference: parseProviderInvoiceReference(
          field(value, 'invoiceReference'),
        ),
      };
    case 'invoice-payment-action-required':
      return {
        ...base,
        kind: 'invoice-payment-action-required',
        invoiceReference: parseProviderInvoiceReference(
          field(value, 'invoiceReference'),
        ),
      };
    case 'cancellation-scheduled':
      return {
        ...base,
        kind: 'cancellation-scheduled',
        cancelAt: number(field(value, 'cancelAt')),
      };
    case 'subscription-cancelled':
      return {
        ...base,
        kind: 'subscription-cancelled',
        cancelledAt: number(field(value, 'cancelledAt')),
      };
    default:
      throw new Error('unknown fixture billing fact');
  }
}

function billingSnapshot(
  value: Record<string, unknown>,
  command: Parameters<typeof planCheckoutCreation>[1],
  mapping: Record<string, unknown>,
): ReconciliationSnapshot {
  const paidValue = field(value, 'latestPaidInvoice');
  const paid = paidValue === null ? null : record(paidValue);
  const delinquencyValue = field(value, 'delinquency');
  const delinquency =
    delinquencyValue === null ? null : record(delinquencyValue);
  const delinquencyReason =
    delinquency === null ? null : string(field(delinquency, 'reason'));
  if (
    delinquencyReason !== null &&
    delinquencyReason !== 'payment-failed' &&
    delinquencyReason !== 'payment-action-required'
  ) {
    throw new Error('invalid fixture delinquency reason');
  }
  const cancelAt = field(value, 'cancelAt');
  const cancelledAt = field(value, 'cancelledAt');
  return {
    snapshotId: parseReconciliationSnapshotId(field(value, 'snapshotId')),
    subscriptionId: command.subscriptionId,
    provider: command.provider,
    providerCustomerReference: parseProviderCustomerReference(
      field(mapping, 'customerReference'),
    ),
    providerSubscriptionReference: parseProviderSubscriptionReference(
      field(mapping, 'subscriptionReference'),
    ),
    observedAt: number(field(value, 'observedAt')),
    recordedAt: number(field(value, 'recordedAt')),
    paymentMethodReady: field(value, 'paymentMethodReady') === true,
    paymentMethodUpdatedAt: number(field(value, 'paymentMethodUpdatedAt')),
    trial: null,
    latestPaidInvoice:
      paid === null
        ? null
        : {
            invoiceReference: parseProviderInvoiceReference(
              field(paid, 'invoiceReference'),
            ),
            paidAt: number(field(paid, 'paidAt')),
            periodStartedAt: number(field(paid, 'periodStartedAt')),
            periodEndsAt: number(field(paid, 'periodEndsAt')),
          },
    delinquency:
      delinquency === null || delinquencyReason === null
        ? null
        : {
            reason: delinquencyReason,
            invoiceReference: parseProviderInvoiceReference(
              field(delinquency, 'invoiceReference'),
            ),
            occurredAt: number(field(delinquency, 'occurredAt')),
          },
    cancelAt: cancelAt === null ? null : number(cancelAt),
    cancellationUpdatedAt: number(field(value, 'cancellationUpdatedAt')),
    cancelledAt: cancelledAt === null ? null : number(cancelledAt),
  };
}

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

function base64UrlBytes(value: string): Uint8Array {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function base64Bytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
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
