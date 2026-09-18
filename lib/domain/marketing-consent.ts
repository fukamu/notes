export const MARKETING_CONSENT_RETENTION_YEARS = 3;

export type MarketingConsentState =
  | { readonly kind: 'never-consented' }
  | {
      readonly kind: 'consented';
      readonly consentedOn: string;
      readonly lastMarketingSentOn: string | null;
    }
  | {
      readonly kind: 'withdrawn';
      readonly consentedOn: string;
      readonly withdrawnOn: string;
      readonly lastMarketingSentOn: string | null;
    };

export type MarketingConsentRecord = Readonly<{
  subjectReference: string;
  state: MarketingConsentState;
}>;

export type MarketingConsentEvent =
  | {
      readonly kind: 'grant-explicit-consent';
      readonly occurredOn: string;
    }
  | { readonly kind: 'record-marketing-send'; readonly occurredOn: string }
  | { readonly kind: 'withdraw-consent'; readonly occurredOn: string };

export type MarketingConsentTransition =
  | { readonly kind: 'applied'; readonly state: MarketingConsentState }
  | {
      readonly kind: 'rejected';
      readonly reason:
        | 'invalid-event-date'
        | 'event-before-current-state'
        | 'marketing-consent-required'
        | 'already-consented'
        | 'already-withdrawn';
    };

export type MarketingDeliveryDecision =
  | { readonly kind: 'allowed' }
  | {
      readonly kind: 'blocked';
      readonly reason: 'explicit-marketing-consent-required';
    };

export type MarketingConsentRetentionPlan =
  | { readonly kind: 'no-record' }
  | { readonly kind: 'invalid-check-date' }
  | {
      readonly kind: 'retain';
      readonly retainThrough: string;
    }
  | {
      readonly kind: 'eligible-for-reviewed-deletion';
      readonly retainThrough: string;
    };

export function applyMarketingConsentEvent(
  state: MarketingConsentState,
  event: MarketingConsentEvent,
): MarketingConsentTransition {
  if (!isCalendarDate(event.occurredOn)) {
    return { kind: 'rejected', reason: 'invalid-event-date' };
  }

  switch (event.kind) {
    case 'grant-explicit-consent':
      if (state.kind === 'consented') {
        return { kind: 'rejected', reason: 'already-consented' };
      }
      if (state.kind === 'withdrawn' && event.occurredOn < state.withdrawnOn) {
        return { kind: 'rejected', reason: 'event-before-current-state' };
      }
      return {
        kind: 'applied',
        state: {
          kind: 'consented',
          consentedOn: event.occurredOn,
          lastMarketingSentOn: null,
        },
      };
    case 'record-marketing-send':
      if (state.kind !== 'consented') {
        return { kind: 'rejected', reason: 'marketing-consent-required' };
      }
      if (
        event.occurredOn < state.consentedOn ||
        (state.lastMarketingSentOn !== null &&
          event.occurredOn < state.lastMarketingSentOn)
      ) {
        return { kind: 'rejected', reason: 'event-before-current-state' };
      }
      return {
        kind: 'applied',
        state: { ...state, lastMarketingSentOn: event.occurredOn },
      };
    case 'withdraw-consent':
      if (state.kind === 'never-consented') {
        return { kind: 'rejected', reason: 'marketing-consent-required' };
      }
      if (state.kind === 'withdrawn') {
        return { kind: 'rejected', reason: 'already-withdrawn' };
      }
      if (
        event.occurredOn < state.consentedOn ||
        (state.lastMarketingSentOn !== null &&
          event.occurredOn < state.lastMarketingSentOn)
      ) {
        return { kind: 'rejected', reason: 'event-before-current-state' };
      }
      return {
        kind: 'applied',
        state: {
          kind: 'withdrawn',
          consentedOn: state.consentedOn,
          withdrawnOn: event.occurredOn,
          lastMarketingSentOn: state.lastMarketingSentOn,
        },
      };
  }
}

export function decideMarketingDelivery(
  state: MarketingConsentState,
): MarketingDeliveryDecision {
  return state.kind === 'consented'
    ? { kind: 'allowed' }
    : { kind: 'blocked', reason: 'explicit-marketing-consent-required' };
}

export function findMarketingConsentRecord(
  records: readonly MarketingConsentRecord[],
  subjectReference: string,
): MarketingConsentRecord | undefined {
  return records.find((record) => record.subjectReference === subjectReference);
}

export function planMarketingConsentRetention(
  state: MarketingConsentState,
  checkedOn: string,
): MarketingConsentRetentionPlan {
  if (!isCalendarDate(checkedOn)) return { kind: 'invalid-check-date' };
  if (state.kind === 'never-consented') return { kind: 'no-record' };

  const anchor =
    state.kind === 'withdrawn'
      ? latestDate(
          state.consentedOn,
          state.lastMarketingSentOn,
          state.withdrawnOn,
        )
      : latestDate(state.consentedOn, state.lastMarketingSentOn);
  const retainThrough = addCalendarYears(
    anchor,
    MARKETING_CONSENT_RETENTION_YEARS,
  );
  return checkedOn <= retainThrough
    ? { kind: 'retain', retainThrough }
    : { kind: 'eligible-for-reviewed-deletion', retainThrough };
}

function latestDate(...values: readonly (string | null)[]): string {
  let latest = '';
  for (const value of values) {
    if (value !== null && value > latest) latest = value;
  }
  return latest;
}

function addCalendarYears(value: string, years: number): string {
  const parts = calendarParts(value);
  if (parts === undefined) return value;
  const targetYear = parts.year + years;
  const targetDay = Math.min(parts.day, daysInMonth(targetYear, parts.month));
  return `${String(targetYear).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(targetDay).padStart(2, '0')}`;
}

function isCalendarDate(value: string): boolean {
  const parts = calendarParts(value);
  return (
    parts !== undefined &&
    parts.month >= 1 &&
    parts.month <= 12 &&
    parts.day >= 1 &&
    parts.day <= daysInMonth(parts.year, parts.month)
  );
}

function calendarParts(
  value: string,
):
  | { readonly year: number; readonly month: number; readonly day: number }
  | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return undefined;
  const yearText = match[1];
  const monthText = match[2];
  const dayText = match[3];
  if (
    yearText === undefined ||
    monthText === undefined ||
    dayText === undefined
  ) {
    return undefined;
  }
  return {
    year: Number(yearText),
    month: Number(monthText),
    day: Number(dayText),
  };
}

function daysInMonth(year: number, month: number): number {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return days[month - 1] ?? 0;
}
