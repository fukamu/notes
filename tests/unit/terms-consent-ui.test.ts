import { describe, expect, it } from 'vitest';
import {
  initialTermsConsentUiState,
  termsConsentUiReducer,
  termsConsentUiReferenceMatches,
  type TermsConsentUiStatus,
} from '@/lib/application/terms-consent-ui';

describe('terms consent UI pure state', () => {
  it('requires a fresh affirmative choice only when the server requires consent', () => {
    const loaded = termsConsentUiReducer(initialTermsConsentUiState, {
      type: 'status-loaded',
      status: requiredStatus(),
      notice: null,
    });
    expect(loaded).toMatchObject({ kind: 'ready', consent: false });
    expect(termsConsentUiReducer(loaded, { type: 'submit-requested' })).toBe(
      loaded,
    );
    const consented = termsConsentUiReducer(loaded, {
      type: 'consent-changed',
      consent: true,
    });
    expect(
      termsConsentUiReducer(consented, { type: 'submit-requested' }),
    ).toMatchObject({ kind: 'submitting', status: { kind: 'current' } });

    const accepted = termsConsentUiReducer(initialTermsConsentUiState, {
      type: 'status-loaded',
      status: acceptedStatus(),
      notice: null,
    });
    expect(
      termsConsentUiReducer(accepted, {
        type: 'consent-changed',
        consent: true,
      }),
    ).toBe(accepted);
  });

  it('keeps a stable retry choice but clears consent after a terms change', () => {
    const submitting = submittingState();
    expect(
      termsConsentUiReducer(submitting, {
        type: 'submit-failed',
        failure: 'unavailable',
      }),
    ).toMatchObject({ kind: 'ready', consent: true });
    expect(
      termsConsentUiReducer(submitting, { type: 'terms-changed' }),
    ).toEqual({ kind: 'loading', reason: 'terms-changed' });
    expect(
      termsConsentUiReducer(
        { kind: 'loading', reason: 'terms-changed' },
        {
          type: 'status-loaded',
          status: {
            kind: 'reconsent-required',
            acceptanceRequired: true,
            current: current(),
            acceptedAt: 1_000,
          },
          notice: 'terms-changed',
        },
      ),
    ).toMatchObject({
      kind: 'ready',
      consent: false,
      notice: 'terms-changed',
    });
  });

  it('moves to accepted only from an in-flight affirmative submission', () => {
    const accepted = termsConsentUiReducer(submittingState(), {
      type: 'accepted',
      status: acceptedStatus(),
    });
    expect(accepted).toMatchObject({
      kind: 'ready',
      status: { kind: 'accepted', acceptanceRequired: false },
      consent: false,
      notice: 'accepted',
    });
  });

  it('compares the complete displayed current reference', () => {
    expect(termsConsentUiReferenceMatches(current(), current())).toBe(true);
    expect(
      termsConsentUiReferenceMatches(current(), {
        ...current(),
        termsHash: `sha256:${'b'.repeat(64)}`,
      }),
    ).toBe(false);
  });
});

function current() {
  return {
    termsVersion: 'terms-v1:2026-09-15',
    termsHash: `sha256:${'a'.repeat(64)}`,
    effectiveDate: '2026-09-15',
  };
}

function requiredStatus(): Extract<
  TermsConsentUiStatus,
  { readonly acceptanceRequired: true }
> {
  return { kind: 'current', acceptanceRequired: true, current: current() };
}

function acceptedStatus(): Extract<
  TermsConsentUiStatus,
  { readonly kind: 'accepted' }
> {
  return {
    kind: 'accepted',
    acceptanceRequired: false,
    current: current(),
    acceptedAt: 2_000,
  };
}

function submittingState() {
  const loaded = termsConsentUiReducer(initialTermsConsentUiState, {
    type: 'status-loaded',
    status: requiredStatus(),
    notice: null,
  });
  const consented = termsConsentUiReducer(loaded, {
    type: 'consent-changed',
    consent: true,
  });
  return termsConsentUiReducer(consented, { type: 'submit-requested' });
}
