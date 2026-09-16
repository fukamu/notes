# Privacy disclosure page and production build gate

Issue #229 adds the canonical, directly addressable privacy page at

- `/legal/privacy`

The page uses the public-only route layout and does not mount the Notes
application. The card editor, history, and connections UI do not contain the
policy body, a persistent privacy panel, or a consent dialog. Public pages expose
only restrained text links. The data-request flow is available at the separate
`/account/privacy` page. Only the destructive account-deletion request uses a
focused, accessible confirmation dialog; the policy body and request controls do
not appear in the normal Notes interface.

This engineering implementation follows the Personal Information Protection
Commission's current general guidance that a purpose of use must be identified
and, after acquisition, notified or made public unless it was published in
advance. The same guidance describes making retained-personal-data information
and request procedures available to the person. The Commission's foreign-transfer
guidance separately requires context-dependent information and safeguards. These
sources establish the engineering need for a reachable policy and a later request
flow, but they do not determine FUKAMU Notes' final legal wording:

- https://www.ppc.go.jp/personalinfo/legal/guidelines_tsusoku/
- https://www.ppc.go.jp/personalinfo/legal/guidelines_offshore/

Qualified Japanese legal review remains a production launch gate.

## Local and test behavior

When `FUKAMU_SERVICE_MODE` is absent or `legacy-test`, the page renders a built-in
fixture. Its controller, purposes, contact, retention, processor, transfer, and
request text is marked as a development sample. An accessible notice states that
it is not a real operator, processor list, contact, or production handling policy.
No identity provider, mail provider, KMS, billing provider, or production data is
used. The local request adapter is in-memory only, does not persist or send the
request, never performs identity verification or deletion, and returns only the
`verification-pending` sample state. Reload and back/forward restoration clear
the displayed request.

## Production configuration

`public-paid` mode requires `FUKAMU_PRIVACY_DISCLOSURE_JSON`. The value is decoded
from `unknown` and must contain the versioned policy/controller fields, every
stable processing category ID with its sources and purposes, fixed product invariants,
retention text, security summary, processor/third-party and foreign-transfer
statements, every supported data-subject request kind, request procedure/contact,
change notice, and an effective date. `policyVersion` must equal
`privacy-v1:<effectiveDate>`.

The fixed product invariants are:

- `serviceName`: `FUKAMU Notes`
- `personalVaultModel`: `one-account-one-personal-vault`
- `retention.localContentOnLogout`: `deleted-on-logout`
- `retention.liveDataOnAccountDeletion`: `deleted-on-account-deletion`
- `retention.backupMaximumDays`: `30`

The decoder rejects unknown/missing fields, malformed dates and URLs, duplicate
categories/items, missing stable processing categories, incomplete request actions,
and drift from those invariants.
Production validation additionally rejects development/placeholder markers,
non-HTTPS/local/example contact URLs, and a controller name without the verified
`株式会社` name.

`npm run build` runs `check:privacy-disclosure` before creating artifacts.
Therefore `public-paid` with missing or invalid privacy configuration fails before
a deployable build exists. This is a completeness and placeholder gate, not legal
approval. The registered company values, collection/purpose wording, retention,
request procedure/fee, provider identities, countries, transfer structure, and
contact operation remain Decision Required until supplied and reviewed.

## Boundaries and rollback

The schema and environment resolution are pure typed functions. Only the
environment adapter reads `process.env`; the page receives a decoded disclosure.
Provider inventory and runtime-retention drift are implemented under Issue #230.
Request storage/API and the separate request UI are implemented under Issues
#231 and #232. Production request routing still fails closed until its approved
composition is configured. No provider call, deployment, or production operation
is part of the disclosure or request UI work.

Rollback is one PR revert of the disclosure contract, environment adapter, page,
link, build gate, tests, and this document. A policy version that has already been
published must be retained under the later policy-version procedure rather than
silently erased.
