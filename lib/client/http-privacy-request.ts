import { v7 as uuidv7 } from 'uuid';
import {
  booleanDecoder,
  literalDecoder,
  objectDecoder,
  safeIntegerDecoder,
  unionDecoder,
} from '@/lib/codec/core';
import type {
  PrivacyRequestUiCommand,
  PrivacyRequestUiFailure,
  PrivacyRequestUiRecord,
} from '@/lib/application/privacy-request-ui';
import {
  parsePrivacyRequestSubmissionId,
  privacyRequestIdDecoder,
  privacyRequestKindDecoder,
  privacyRequestOutcomeDecoder,
} from '@/server/privacy-request/public';

type FetchRequest = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type PrivacyRequestTransportResult =
  | { readonly kind: 'accepted'; readonly request: PrivacyRequestUiRecord }
  | { readonly kind: 'rejected'; readonly reason: PrivacyRequestUiFailure };

export type PrivacyRequestUiTransport = Readonly<{
  submit(
    command: PrivacyRequestUiCommand,
  ): Promise<PrivacyRequestTransportResult>;
  status(
    request: Pick<PrivacyRequestUiRecord, 'requestId'>,
  ): Promise<PrivacyRequestTransportResult>;
}>;

const base = {
  requestId: privacyRequestIdDecoder,
  requestKind: privacyRequestKindDecoder,
  requestedAt: safeIntegerDecoder({ minimum: 0 }),
  updatedAt: safeIntegerDecoder({ minimum: 0 }),
} as const;

const responseDecoder = unionDecoder(
  objectDecoder({ ...base, status: literalDecoder('verification-pending') }),
  objectDecoder({ ...base, status: literalDecoder('ready') }),
  objectDecoder({ ...base, status: literalDecoder('processing') }),
  objectDecoder({
    ...base,
    status: literalDecoder('completed'),
    outcome: privacyRequestOutcomeDecoder,
  }),
  objectDecoder({ ...base, status: literalDecoder('rejected') }),
  objectDecoder({
    ...base,
    status: literalDecoder('failed'),
    retryable: booleanDecoder,
  }),
);

const errorDecoder = objectDecoder({
  error: unionDecoder(
    literalDecoder('authentication-required'),
    literalDecoder('forbidden'),
    literalDecoder('not-found'),
    literalDecoder('request-conflict'),
    literalDecoder('invalid-request'),
    literalDecoder('request-too-large'),
    literalDecoder('unavailable'),
  ),
});

export function createPrivacyRequestUiHttpTransport(
  fetchRequest: FetchRequest = fetch,
): PrivacyRequestUiTransport {
  return {
    async submit(command) {
      const result = await post(
        fetchRequest,
        '/api/account/privacy-requests',
        command,
      );
      if (result.kind === 'rejected') return result;
      return result.request.requestKind === command.requestKind
        ? result
        : { kind: 'rejected', reason: 'unavailable' };
    },

    async status(command) {
      const result = await post(
        fetchRequest,
        '/api/account/privacy-requests/status',
        command,
      );
      if (result.kind === 'rejected') return result;
      return result.request.requestId === command.requestId
        ? result
        : { kind: 'rejected', reason: 'unavailable' };
    },
  };
}

export function createPrivacyRequestSubmissionId(): string {
  return parsePrivacyRequestSubmissionId(uuidv7());
}

async function post(
  fetchRequest: FetchRequest,
  input: string,
  bodyValue:
    | PrivacyRequestUiCommand
    | Pick<PrivacyRequestUiRecord, 'requestId'>,
): Promise<PrivacyRequestTransportResult> {
  let response: Response;
  try {
    response = await fetchRequest(input, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(bodyValue),
      cache: 'no-store',
      credentials: 'same-origin',
      redirect: 'error',
    });
  } catch {
    return { kind: 'rejected', reason: 'unavailable' };
  }
  const value = await responseBody(response);
  if (!response.ok) return rejected(response.status, value);
  const decoded = responseDecoder.decode(value);
  return decoded.ok
    ? { kind: 'accepted', request: decoded.value }
    : { kind: 'rejected', reason: 'unavailable' };
}

async function responseBody(response: Response): Promise<unknown> {
  try {
    const value: unknown = await response.json();
    return value;
  } catch {
    return undefined;
  }
}

function rejected(
  status: number,
  value: unknown,
): Extract<PrivacyRequestTransportResult, { readonly kind: 'rejected' }> {
  const decoded = errorDecoder.decode(value);
  if (!decoded.ok) return { kind: 'rejected', reason: 'unavailable' };
  if (
    (status === 401 && decoded.value.error === 'authentication-required') ||
    (status === 403 && decoded.value.error === 'forbidden')
  ) {
    return { kind: 'rejected', reason: 'authentication-required' };
  }
  if (status === 404 && decoded.value.error === 'not-found') {
    return { kind: 'rejected', reason: 'not-found' };
  }
  if (status === 409 && decoded.value.error === 'request-conflict') {
    return { kind: 'rejected', reason: 'request-conflict' };
  }
  return { kind: 'rejected', reason: 'unavailable' };
}
