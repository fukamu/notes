# Personal-data incident reporting tabletop

Issue #135 adds a deterministic tabletop timeline, not an incident declaration,
legal conclusion, regulator report, user notification, or production operation.
The incident lead must first obtain an authorized assessment of whether the
event is reportable. Code must not infer reportability from log categories or
counts alone.

For an event confirmed as reportable, the pure planner calculates:

- a preliminary-report working target by three calendar days after discovery
  and outer guidance by five calendar days;
- a final report date 30 calendar days after discovery, or 60 calendar days
  when malicious purpose is suspected; and
- notification to affected people promptly, without inventing a fixed statutory
  day count where the source says promptly.

These dates are scheduling safeguards based on the current Personal Information
Protection Commission guidance. The incident owner must verify the law and
official form current at the time, record the actual discovery facts and legal
assessment in the approved incident system, and escalate earlier whenever the
facts permit. A date calculator is not permission to wait until the last day.

## Tabletop sequence

1. Preserve evidence without copying user content, keys, OTPs, session tokens,
   card data, or tenant identifiers into telemetry or this repository.
2. Assign an incident lead, privacy/legal reviewer, security owner, service
   owner, notification owner, and the real emergency contact.
3. Record discovery time, containment state, affected systems, estimated people,
   categories, malicious-purpose assessment, and reportability decision in the
   approved system.
4. If reportable, submit the preliminary and final reports using the current PPC
   process and notify affected people promptly in clear language. Record only an
   approved-system reference in the launch manifest.
5. Continue containment, tenant-isolation checks, credential/session response,
   recovery, user support, evidence preservation, and post-incident review.

The real contact and a reviewed exercise remain launch blockers. Any report,
user notification, provider action, deployment, production data change, key
operation, or real email requires the authority and approvals applicable to that
operation.

- [PPC response to leaks and similar incidents](https://www.ppc.go.jp/personalinfo/legal/leakAction/)
- [PPC overview of mandatory reporting and notification](https://www.ppc.go.jp/news/kaiseihou_feature/roueitouhoukoku_gimuka/)
- [Production operations runbook](./production-operations-runbook.md)
- [Launch compliance gate](./legal-launch-compliance.md)
