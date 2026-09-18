export type TermsConsentUiReference = Readonly<{
  termsVersion: string;
  termsHash: string;
  effectiveDate: string;
}>;

export type TermsConsentUiStatus =
  | {
      readonly kind: 'current';
      readonly acceptanceRequired: true;
      readonly current: TermsConsentUiReference;
    }
  | {
      readonly kind: 'accepted';
      readonly acceptanceRequired: false;
      readonly current: TermsConsentUiReference;
      readonly acceptedAt: number | null;
    }
  | {
      readonly kind: 'reconsent-required';
      readonly acceptanceRequired: true;
      readonly current: TermsConsentUiReference;
      readonly acceptedAt: number;
    }
  | {
      readonly kind: 'notice-only';
      readonly acceptanceRequired: false;
      readonly current: TermsConsentUiReference;
      readonly acceptedAt: number;
    };

export type TermsConsentUiFailure =
  | 'authentication-required'
  | 'request-conflict'
  | 'unavailable';

export type TermsConsentUiState =
  | {
      readonly kind: 'loading';
      readonly reason: 'initial' | 'terms-changed';
    }
  | {
      readonly kind: 'ready';
      readonly status: TermsConsentUiStatus;
      readonly consent: boolean;
      readonly failure: TermsConsentUiFailure | null;
      readonly notice: 'terms-changed' | 'accepted' | null;
    }
  | {
      readonly kind: 'submitting';
      readonly status: Extract<
        TermsConsentUiStatus,
        { readonly acceptanceRequired: true }
      >;
    }
  | {
      readonly kind: 'unavailable';
      readonly failure: 'authentication-required' | 'unavailable';
    };

export type TermsConsentUiAction =
  | {
      readonly type: 'status-loaded';
      readonly status: TermsConsentUiStatus;
      readonly notice: 'terms-changed' | null;
    }
  | {
      readonly type: 'status-load-failed';
      readonly failure: 'authentication-required' | 'unavailable';
    }
  | { readonly type: 'consent-changed'; readonly consent: boolean }
  | { readonly type: 'submit-requested' }
  | {
      readonly type: 'submit-failed';
      readonly failure: TermsConsentUiFailure;
    }
  | { readonly type: 'terms-changed' }
  | {
      readonly type: 'accepted';
      readonly status: Extract<
        TermsConsentUiStatus,
        { readonly kind: 'accepted' }
      >;
    };

export const initialTermsConsentUiState: TermsConsentUiState = {
  kind: 'loading',
  reason: 'initial',
};

export function termsConsentUiReducer(
  state: TermsConsentUiState,
  action: TermsConsentUiAction,
): TermsConsentUiState {
  switch (action.type) {
    case 'status-loaded':
      return {
        kind: 'ready',
        status: action.status,
        consent: false,
        failure: null,
        notice: action.notice,
      };
    case 'status-load-failed':
      return { kind: 'unavailable', failure: action.failure };
    case 'consent-changed':
      return state.kind === 'ready' && state.status.acceptanceRequired
        ? { ...state, consent: action.consent, failure: null }
        : state;
    case 'submit-requested':
      return state.kind === 'ready' &&
        state.status.acceptanceRequired &&
        state.consent
        ? { kind: 'submitting', status: state.status }
        : state;
    case 'submit-failed':
      return state.kind === 'submitting'
        ? {
            kind: 'ready',
            status: state.status,
            consent: true,
            failure: action.failure,
            notice: null,
          }
        : state;
    case 'terms-changed':
      return state.kind === 'submitting'
        ? { kind: 'loading', reason: 'terms-changed' }
        : state;
    case 'accepted':
      return state.kind === 'submitting'
        ? {
            kind: 'ready',
            status: action.status,
            consent: false,
            failure: null,
            notice: 'accepted',
          }
        : state;
  }
}

export function termsConsentUiReferenceMatches(
  left: TermsConsentUiReference,
  right: TermsConsentUiReference,
): boolean {
  return (
    left.termsVersion === right.termsVersion &&
    left.termsHash === right.termsHash &&
    left.effectiveDate === right.effectiveDate
  );
}
