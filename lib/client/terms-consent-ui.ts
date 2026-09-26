import { v7 as uuidv7 } from 'uuid';
import {
  booleanDecoder,
  literalDecoder,
  objectDecoder,
  refineDecoder,
  safeIntegerDecoder,
  stringDecoder,
  transformDecoder,
  unionDecoder,
  type Decoder,
} from '@/lib/codec/core';
import {
  termsConsentUiReferenceMatches,
  type TermsConsentUiReference,
  type TermsConsentUiStatus,
} from '@/lib/application/terms-consent-ui';
import {
  termsConsentIdDecoder,
  termsConsentSubmissionIdDecoder,
  termsDocumentHashDecoder,
  termsVersionDecoder,
  type TermsConsentSubmissionId,
} from '@/lib/contracts/terms-consent';

type FetchRequest = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type TermsConsentStatusLoadResult =
  | { readonly kind: 'available'; readonly status: TermsConsentUiStatus }
  | { readonly kind: 'authentication-required' }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'unavailable' };

export type TermsConsentAcceptResult =
  | {
      readonly kind: 'accepted';
      readonly outcome: 'recorded' | 'replayed';
      readonly status: Extract<
        TermsConsentUiStatus,
        { readonly kind: 'accepted' }
      >;
    }
  | { readonly kind: 'terms-changed' }
  | { readonly kind: 'authentication-required' }
  | { readonly kind: 'request-conflict' }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'unavailable' };

export type TermsConsentUiTransport = Readonly<{
  loadStatus(): Promise<TermsConsentStatusLoadResult>;
  accept(input: {
    readonly current: TermsConsentUiReference;
    readonly submissionId: TermsConsentSubmissionId;
  }): Promise<TermsConsentAcceptResult>;
}>;

const dateDecoder = refineDecoder(
  stringDecoder({ minLength: 10, maxLength: 10 }),
  (value) => /^\d{4}-\d{2}-\d{2}$/.test(value),
  'expected YYYY-MM-DD',
);

const trueDecoder: Decoder<true> = transformDecoder(
  refineDecoder(booleanDecoder, (value) => value, 'expected true'),
  () => true,
);
const falseDecoder: Decoder<false> = transformDecoder(
  refineDecoder(booleanDecoder, (value) => !value, 'expected false'),
  () => false,
);

const currentReferenceDecoder = objectDecoder({
  termsVersion: termsVersionDecoder,
  termsHash: termsDocumentHashDecoder,
  effectiveDate: dateDecoder,
});

const acceptedReferenceDecoder = objectDecoder({
  consentId: termsConsentIdDecoder,
  termsVersion: termsVersionDecoder,
  termsHash: termsDocumentHashDecoder,
  acceptedAt: safeIntegerDecoder({ minimum: 0 }),
});

type RawTermsConsentStatus =
  | {
      readonly kind: 'current';
      readonly acceptanceRequired: true;
      readonly current: TermsConsentUiReference;
    }
  | {
      readonly kind: 'accepted';
      readonly acceptanceRequired: false;
      readonly current: TermsConsentUiReference;
      readonly accepted: { readonly acceptedAt: number };
    }
  | {
      readonly kind: 'reconsent-required';
      readonly acceptanceRequired: true;
      readonly current: TermsConsentUiReference;
      readonly accepted: { readonly acceptedAt: number };
    }
  | {
      readonly kind: 'notice-only';
      readonly acceptanceRequired: false;
      readonly current: TermsConsentUiReference;
      readonly accepted: { readonly acceptedAt: number };
    };

const statusDecoder: Decoder<RawTermsConsentStatus> = unionDecoder(
  objectDecoder({
    kind: literalDecoder('current'),
    acceptanceRequired: trueDecoder,
    current: currentReferenceDecoder,
  }),
  objectDecoder({
    kind: literalDecoder('accepted'),
    acceptanceRequired: falseDecoder,
    current: currentReferenceDecoder,
    accepted: acceptedReferenceDecoder,
  }),
  objectDecoder({
    kind: literalDecoder('reconsent-required'),
    acceptanceRequired: trueDecoder,
    current: currentReferenceDecoder,
    accepted: acceptedReferenceDecoder,
  }),
  objectDecoder({
    kind: literalDecoder('notice-only'),
    acceptanceRequired: falseDecoder,
    current: currentReferenceDecoder,
    accepted: acceptedReferenceDecoder,
  }),
);

const statusResponseDecoder = objectDecoder({
  outcome: literalDecoder('status'),
  status: statusDecoder,
});

const acceptResponseDecoder = objectDecoder({
  outcome: unionDecoder(literalDecoder('recorded'), literalDecoder('replayed')),
  status: objectDecoder({
    kind: literalDecoder('accepted'),
    acceptanceRequired: falseDecoder,
    current: currentReferenceDecoder,
    accepted: acceptedReferenceDecoder,
  }),
});

const errorResponseDecoder = objectDecoder({
  error: unionDecoder(
    literalDecoder('authentication-required'),
    literalDecoder('forbidden'),
    literalDecoder('not-found'),
    literalDecoder('terms-changed'),
    literalDecoder('request-conflict'),
    literalDecoder('invalid-request'),
    literalDecoder('request-too-large'),
    literalDecoder('consent-required'),
    literalDecoder('unavailable'),
  ),
});

export function createTermsConsentUiHttpTransport(
  fetchRequest: FetchRequest = fetch,
): TermsConsentUiTransport {
  return {
    async loadStatus() {
      const response = await request(fetchRequest, { method: 'GET' });
      if (response === undefined) return { kind: 'unavailable' };
      if (!response.ok)
        return loadFailure(response.status, await body(response));
      const decoded = statusResponseDecoder.decode(await body(response));
      return decoded.ok
        ? { kind: 'available', status: normalizeStatus(decoded.value.status) }
        : { kind: 'unavailable' };
    },

    async accept(input) {
      const submissionId = termsConsentSubmissionIdDecoder.decode(
        input.submissionId,
      );
      if (!submissionId.ok) return { kind: 'unavailable' };
      const response = await request(fetchRequest, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          submissionId: submissionId.value,
          presentedTermsVersion: input.current.termsVersion,
          presentedTermsHash: input.current.termsHash,
          consent: { kind: 'affirmed' },
        }),
      });
      if (response === undefined) return { kind: 'unavailable' };
      if (!response.ok) {
        return acceptFailure(response.status, await body(response));
      }
      const decoded = acceptResponseDecoder.decode(await body(response));
      if (
        !decoded.ok ||
        !termsConsentUiReferenceMatches(
          decoded.value.status.current,
          input.current,
        ) ||
        decoded.value.status.accepted.termsVersion !==
          input.current.termsVersion ||
        decoded.value.status.accepted.termsHash !== input.current.termsHash
      ) {
        return { kind: 'unavailable' };
      }
      return {
        kind: 'accepted',
        outcome: decoded.value.outcome,
        status: normalizeAccepted(decoded.value.status),
      };
    },
  };
}

export function createLocalTermsConsentUiTransport(
  current: TermsConsentUiReference,
): TermsConsentUiTransport {
  let accepted = false;
  return {
    async loadStatus() {
      return {
        kind: 'available',
        status: accepted
          ? {
              kind: 'accepted',
              acceptanceRequired: false,
              current,
              acceptedAt: null,
            }
          : { kind: 'current', acceptanceRequired: true, current },
      };
    },
    async accept(input) {
      if (!termsConsentSubmissionIdDecoder.decode(input.submissionId).ok) {
        return { kind: 'unavailable' };
      }
      if (!termsConsentUiReferenceMatches(input.current, current)) {
        return { kind: 'terms-changed' };
      }
      const outcome = accepted ? 'replayed' : 'recorded';
      accepted = true;
      return {
        kind: 'accepted',
        outcome,
        status: {
          kind: 'accepted',
          acceptanceRequired: false,
          current,
          acceptedAt: null,
        },
      };
    },
  };
}

export function createRemoteFirstTermsConsentUiTransport(
  fallback: TermsConsentUiTransport,
  remote: TermsConsentUiTransport = createTermsConsentUiHttpTransport(),
): TermsConsentUiTransport {
  return {
    async loadStatus() {
      const result = await remote.loadStatus();
      return result.kind === 'not-found' ? fallback.loadStatus() : result;
    },
    async accept(input) {
      const result = await remote.accept(input);
      return result.kind === 'not-found' ? fallback.accept(input) : result;
    },
  };
}

export function createTermsConsentSubmissionId(): TermsConsentSubmissionId {
  const decoded = termsConsentSubmissionIdDecoder.decode(uuidv7());
  if (!decoded.ok) throw new Error('generated invalid terms submission ID');
  return decoded.value;
}

async function request(
  fetchRequest: FetchRequest,
  init: RequestInit,
): Promise<Response | undefined> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  try {
    return await fetchRequest('/api/account/terms-consent', {
      ...init,
      cache: 'no-store',
      credentials: 'same-origin',
      headers,
    });
  } catch {
    return undefined;
  }
}

async function body(response: Response): Promise<unknown> {
  try {
    const value: unknown = await response.json();
    return value;
  } catch {
    return undefined;
  }
}

function loadFailure(
  status: number,
  input: unknown,
): TermsConsentStatusLoadResult {
  const error = decodedError(input);
  if (status === 401 && error === 'authentication-required') {
    return { kind: 'authentication-required' };
  }
  if (status === 404 && error === 'not-found') return { kind: 'not-found' };
  return { kind: 'unavailable' };
}

function acceptFailure(
  status: number,
  input: unknown,
): TermsConsentAcceptResult {
  const error = decodedError(input);
  if (status === 401 && error === 'authentication-required') {
    return { kind: 'authentication-required' };
  }
  if (status === 404 && error === 'not-found') return { kind: 'not-found' };
  if (status === 409 && error === 'terms-changed') {
    return { kind: 'terms-changed' };
  }
  if (status === 409 && error === 'request-conflict') {
    return { kind: 'request-conflict' };
  }
  return { kind: 'unavailable' };
}

function decodedError(input: unknown) {
  const decoded = errorResponseDecoder.decode(input);
  return decoded.ok ? decoded.value.error : undefined;
}

function normalizeStatus(status: RawTermsConsentStatus): TermsConsentUiStatus {
  switch (status.kind) {
    case 'current':
      return status;
    case 'accepted':
      return normalizeAccepted(status);
    case 'reconsent-required':
      return {
        kind: status.kind,
        acceptanceRequired: true,
        current: status.current,
        acceptedAt: status.accepted.acceptedAt,
      };
    case 'notice-only':
      return {
        kind: status.kind,
        acceptanceRequired: false,
        current: status.current,
        acceptedAt: status.accepted.acceptedAt,
      };
  }
}

function normalizeAccepted(status: {
  readonly kind: 'accepted';
  readonly acceptanceRequired: false;
  readonly current: TermsConsentUiReference;
  readonly accepted: { readonly acceptedAt: number };
}): Extract<TermsConsentUiStatus, { readonly kind: 'accepted' }> {
  return {
    kind: 'accepted',
    acceptanceRequired: false,
    current: status.current,
    acceptedAt: status.accepted.acceptedAt,
  };
}
