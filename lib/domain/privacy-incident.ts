export type PrivacyIncidentTimelineInput = Readonly<{
  discoveredOn: string;
  reportingAssessment: 'assessment-required' | 'reportable-confirmed';
  maliciousPurpose: 'not-suspected' | 'suspected';
}>;

export type PrivacyIncidentTimeline =
  | { readonly kind: 'invalid-discovery-date' }
  | {
      readonly kind: 'reportability-assessment-required';
      readonly notification: 'promptly-after-assessment';
    }
  | {
      readonly kind: 'reporting-timeline';
      readonly preliminaryReport: Readonly<{
        workingTargetBy: string;
        outerGuidanceBy: string;
        basis: 'approximately-three-to-five-calendar-days';
      }>;
      readonly finalReport: Readonly<{
        dueOn: string;
        basis:
          | 'thirty-calendar-days'
          | 'sixty-calendar-days-for-suspected-malicious-purpose';
      }>;
      readonly notification: 'promptly-without-invented-fixed-day-count';
    };

export function planPrivacyIncidentTimeline(
  input: PrivacyIncidentTimelineInput,
): PrivacyIncidentTimeline {
  if (!isCalendarDate(input.discoveredOn)) {
    return { kind: 'invalid-discovery-date' };
  }
  if (input.reportingAssessment === 'assessment-required') {
    return {
      kind: 'reportability-assessment-required',
      notification: 'promptly-after-assessment',
    };
  }

  const maliciousPurpose = input.maliciousPurpose === 'suspected';
  return {
    kind: 'reporting-timeline',
    preliminaryReport: {
      workingTargetBy: addCalendarDays(input.discoveredOn, 3),
      outerGuidanceBy: addCalendarDays(input.discoveredOn, 5),
      basis: 'approximately-three-to-five-calendar-days',
    },
    finalReport: {
      dueOn: addCalendarDays(input.discoveredOn, maliciousPurpose ? 60 : 30),
      basis: maliciousPurpose
        ? 'sixty-calendar-days-for-suspected-malicious-purpose'
        : 'thirty-calendar-days',
    },
    notification: 'promptly-without-invented-fixed-day-count',
  };
}

function addCalendarDays(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.valueOf()) && parsed.toISOString().startsWith(value)
  );
}
