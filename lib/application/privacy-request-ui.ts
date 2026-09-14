import type { PrivacyRequestKind } from '@/lib/domain/privacy-request';

type PrivacyRequestUiBase = {
  readonly requestId: string;
  readonly requestKind: PrivacyRequestKind;
  readonly requestedAt: number;
  readonly updatedAt: number;
};

export type PrivacyRequestUiRecord = PrivacyRequestUiBase &
  (
    | { readonly status: 'verification-pending' }
    | { readonly status: 'ready' }
    | { readonly status: 'processing' }
    | {
        readonly status: 'completed';
        readonly outcome: 'fulfilled' | 'account-deletion-started';
      }
    | { readonly status: 'rejected' }
    | {
        readonly status: 'failed';
        readonly retryable: boolean;
      }
  );

export type PrivacyRequestUiCommand = {
  readonly submissionId: string;
  readonly requestKind: PrivacyRequestKind;
};

export type PrivacyRequestUiFailure =
  | 'authentication-required'
  | 'request-conflict'
  | 'not-found'
  | 'unavailable';

type PrivacyRequestDraftState = {
  readonly kind: 'draft';
  readonly requestKind: PrivacyRequestKind;
  readonly confirmation: 'closed' | 'open';
  readonly retrySubmissionId: string | null;
  readonly failure: PrivacyRequestUiFailure | null;
};

export type PrivacyRequestUiState =
  | PrivacyRequestDraftState
  | {
      readonly kind: 'submitting';
      readonly command: PrivacyRequestUiCommand;
    }
  | {
      readonly kind: 'tracking';
      readonly request: PrivacyRequestUiRecord;
      readonly refresh: 'idle' | 'refreshing';
      readonly failure: PrivacyRequestUiFailure | null;
    };

export type PrivacyRequestUiAction =
  | {
      readonly type: 'request-kind-selected';
      readonly requestKind: PrivacyRequestKind;
    }
  | { readonly type: 'confirmation-requested' }
  | { readonly type: 'confirmation-cancelled' }
  | {
      readonly type: 'submission-requested';
      readonly newSubmissionId: string;
    }
  | {
      readonly type: 'submission-accepted';
      readonly request: PrivacyRequestUiRecord;
    }
  | {
      readonly type: 'submission-failed';
      readonly failure: PrivacyRequestUiFailure;
    }
  | { readonly type: 'refresh-requested' }
  | {
      readonly type: 'refresh-accepted';
      readonly request: PrivacyRequestUiRecord;
    }
  | {
      readonly type: 'refresh-failed';
      readonly failure: PrivacyRequestUiFailure;
    }
  | { readonly type: 'another-request-requested' }
  | { readonly type: 'page-reentered' };

export const initialPrivacyRequestUiState: PrivacyRequestUiState = {
  kind: 'draft',
  requestKind: 'disclosure',
  confirmation: 'closed',
  retrySubmissionId: null,
  failure: null,
};

export function privacyRequestUiReducer(
  state: PrivacyRequestUiState,
  action: PrivacyRequestUiAction,
): PrivacyRequestUiState {
  switch (action.type) {
    case 'request-kind-selected':
      return state.kind === 'draft'
        ? {
            kind: 'draft',
            requestKind: action.requestKind,
            confirmation: 'closed',
            retrySubmissionId:
              action.requestKind === state.requestKind
                ? state.retrySubmissionId
                : null,
            failure: null,
          }
        : state;
    case 'confirmation-requested':
      return state.kind === 'draft' && state.requestKind === 'deletion'
        ? { ...state, confirmation: 'open' }
        : state;
    case 'confirmation-cancelled':
      return state.kind === 'draft' && state.confirmation === 'open'
        ? { ...state, confirmation: 'closed', failure: null }
        : state;
    case 'submission-requested':
      if (state.kind !== 'draft') return state;
      if (state.requestKind === 'deletion' && state.confirmation !== 'open') {
        return state;
      }
      return {
        kind: 'submitting',
        command: {
          submissionId: state.retrySubmissionId ?? action.newSubmissionId,
          requestKind: state.requestKind,
        },
      };
    case 'submission-accepted':
      if (state.kind !== 'submitting') return state;
      return state.command.requestKind === action.request.requestKind
        ? {
            kind: 'tracking',
            request: action.request,
            refresh: 'idle',
            failure: null,
          }
        : submissionFailureState(state, 'unavailable');
    case 'submission-failed':
      return state.kind === 'submitting'
        ? submissionFailureState(state, action.failure)
        : state;
    case 'refresh-requested':
      return state.kind === 'tracking' && state.refresh === 'idle'
        ? { ...state, refresh: 'refreshing', failure: null }
        : state;
    case 'refresh-accepted':
      if (state.kind !== 'tracking' || state.refresh !== 'refreshing') {
        return state;
      }
      return state.request.requestId === action.request.requestId &&
        state.request.requestKind === action.request.requestKind
        ? {
            kind: 'tracking',
            request: action.request,
            refresh: 'idle',
            failure: null,
          }
        : { ...state, refresh: 'idle', failure: 'unavailable' };
    case 'refresh-failed':
      return state.kind === 'tracking' && state.refresh === 'refreshing'
        ? { ...state, refresh: 'idle', failure: action.failure }
        : state;
    case 'another-request-requested':
      return state.kind === 'tracking' && state.refresh === 'idle'
        ? {
            kind: 'draft',
            requestKind: state.request.requestKind,
            confirmation: 'closed',
            retrySubmissionId: null,
            failure: null,
          }
        : state;
    case 'page-reentered':
      return initialPrivacyRequestUiState;
  }
}

export type PrivacyRequestStatusPresentation = {
  readonly label: string;
  readonly detail: string;
  readonly terminal: boolean;
};

export function privacyRequestStatusPresentation(
  request: PrivacyRequestUiRecord,
): PrivacyRequestStatusPresentation {
  switch (request.status) {
    case 'verification-pending':
      return {
        label: '本人確認待ち',
        detail:
          '本人確認方法は本番運用前に確定します。確認が終わるまで請求内容の処理は始まりません。',
        terminal: false,
      };
    case 'ready':
      return {
        label: '本人確認済み・処理待ち',
        detail: '本人確認が完了し、安全な処理開始を待っています。',
        terminal: false,
      };
    case 'processing':
      return {
        label: '処理中',
        detail:
          '請求内容を処理しています。状態はこのページから再確認できます。',
        terminal: false,
      };
    case 'completed':
      return request.outcome === 'account-deletion-started'
        ? {
            label: '退会処理を開始済み',
            detail:
              '本人確認後、既存の退会・端末内データ削除処理へ引き継ぎました。ここで削除完了とは扱いません。',
            terminal: true,
          }
        : {
            label: '処理完了',
            detail: '請求内容の処理が完了しました。',
            terminal: true,
          };
    case 'rejected':
      return {
        label: '受付後に不成立',
        detail:
          '本人確認または請求対象を確認できませんでした。詳細は個人情報に関する窓口へお問い合わせください。',
        terminal: true,
      };
    case 'failed':
      return {
        label: request.retryable ? '一時的に処理できません' : '処理できません',
        detail: request.retryable
          ? '受付状態は保持されています。時間をおいて状態を再確認してください。'
          : '自動再試行の対象ではありません。個人情報に関する窓口へお問い合わせください。',
        terminal: true,
      };
  }
}

function submissionFailureState(
  state: Extract<PrivacyRequestUiState, { readonly kind: 'submitting' }>,
  failure: PrivacyRequestUiFailure,
): PrivacyRequestDraftState {
  return {
    kind: 'draft',
    requestKind: state.command.requestKind,
    confirmation: state.command.requestKind === 'deletion' ? 'open' : 'closed',
    retrySubmissionId: state.command.submissionId,
    failure,
  };
}
