import { v7 as uuidv7 } from 'uuid';
import type { PrivacyRequestUiRecord } from '@/lib/application/privacy-request-ui';
import type {
  PrivacyRequestTransportResult,
  PrivacyRequestUiTransport,
} from '@/lib/client/http-privacy-request';
import { parsePrivacyRequestId } from '@/server/privacy-request/public';

// Local-only, in-memory sample. It deliberately has no persistence and never
// performs identity verification, account deletion, network, or provider work.
export function createLocalPrivacyRequestUiTransport(
  now: () => number = Date.now,
): PrivacyRequestUiTransport {
  const bySubmission = new Map<string, PrivacyRequestUiRecord>();
  const byRequest = new Map<string, PrivacyRequestUiRecord>();
  return {
    async submit(command) {
      const existing = bySubmission.get(command.submissionId);
      if (existing !== undefined) {
        return existing.requestKind === command.requestKind
          ? accepted(existing)
          : { kind: 'rejected', reason: 'request-conflict' };
      }
      const requestedAt = now();
      if (!Number.isSafeInteger(requestedAt) || requestedAt < 0) {
        return { kind: 'rejected', reason: 'unavailable' };
      }
      const request: PrivacyRequestUiRecord = {
        requestId: parsePrivacyRequestId(uuidv7()),
        requestKind: command.requestKind,
        requestedAt,
        updatedAt: requestedAt,
        status: 'verification-pending',
      };
      bySubmission.set(command.submissionId, request);
      byRequest.set(request.requestId, request);
      return accepted(request);
    },

    async status(command) {
      const request = byRequest.get(command.requestId);
      return request === undefined
        ? { kind: 'rejected', reason: 'not-found' }
        : accepted(request);
    },
  };
}

function accepted(
  request: PrivacyRequestUiRecord,
): PrivacyRequestTransportResult {
  return { kind: 'accepted', request };
}
