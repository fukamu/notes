import { describe, expect, it } from 'vitest';
import { planPrivacyIncidentTimeline } from '@/lib/domain/privacy-incident';

describe('personal-data incident reporting tabletop', () => {
  it('does not infer reportability before an authorized assessment', () => {
    expect(
      planPrivacyIncidentTimeline({
        discoveredOn: '2026-09-15',
        reportingAssessment: 'assessment-required',
        maliciousPurpose: 'not-suspected',
      }),
    ).toEqual({
      kind: 'reportability-assessment-required',
      notification: 'promptly-after-assessment',
    });
  });

  it('plans the preliminary window, 30-day report and prompt notice', () => {
    expect(
      planPrivacyIncidentTimeline({
        discoveredOn: '2026-09-15',
        reportingAssessment: 'reportable-confirmed',
        maliciousPurpose: 'not-suspected',
      }),
    ).toEqual({
      kind: 'reporting-timeline',
      preliminaryReport: {
        workingTargetBy: '2026-09-18',
        outerGuidanceBy: '2026-09-20',
        basis: 'approximately-three-to-five-calendar-days',
      },
      finalReport: {
        dueOn: '2026-10-15',
        basis: 'thirty-calendar-days',
      },
      notification: 'promptly-without-invented-fixed-day-count',
    });
  });

  it('uses the 60-day branch when malicious purpose is suspected', () => {
    expect(
      planPrivacyIncidentTimeline({
        discoveredOn: '2026-12-15',
        reportingAssessment: 'reportable-confirmed',
        maliciousPurpose: 'suspected',
      }),
    ).toMatchObject({
      kind: 'reporting-timeline',
      finalReport: {
        dueOn: '2027-02-13',
        basis: 'sixty-calendar-days-for-suspected-malicious-purpose',
      },
    });
  });

  it('rejects a malformed discovery date', () => {
    expect(
      planPrivacyIncidentTimeline({
        discoveredOn: '2026-02-30',
        reportingAssessment: 'reportable-confirmed',
        maliciousPurpose: 'not-suspected',
      }),
    ).toEqual({ kind: 'invalid-discovery-date' });
  });
});
