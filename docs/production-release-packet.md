# Restricted production release packet

This is the review and evidence template for the first restricted Go release.
It is not a credential store and does not authorize a provider operation. Fill
each required field with an immutable value or an approved audit-system
reference. Leave an unknown field explicitly `pending`; never invent evidence.

## Release identity

| Field                    | Required value                                                     |
| ------------------------ | ------------------------------------------------------------------ |
| source                   | exact `main` commit SHA after the approved main PR                 |
| runtime image            | immutable registry digest and OCI revision label                   |
| operations image         | independently pinned `notesctl` registry digest                    |
| release evidence         | retained `manifest.json` and `sbom.spdx.json` SHA-256              |
| schema                   | embedded target version and checksum from guarded migration output |
| frontend                 | manifest/service-worker/static asset hashes from release evidence  |
| prior compatible release | digest plus compatibility result, or `none — first Go release`     |

Record registry and CI URLs, not credentials or mutable tags. Both images must
come from the same reviewed source SHA. Deployment must select the runtime
digest; migration and access jobs must select the operations digest.

## Approved target and cost boundary

Record the approved provider account/project, region, production domain,
PostgreSQL host and database name, private object bucket, full enabled KMS key
version, runtime and operations service identities, alert destination, owner,
maintenance window, and monthly cost ceiling. Record Secret Manager resource
and version references for the database URL, OAuth client secret, and cursor
HMAC key; do not copy their values here.

General public access and `billing-checkout` must both remain OFF. Record each
initial allowed user's verified Google `sub` only in the approved access/audit
system, not this repository. The packet contains that record's reference,
approved expiry, and limits.

## Database and restricted-access evidence

Run the separately pinned operations image with secret injection supplied by
the platform. Preserve the redacted JSON and its capture timestamp.

1. Before migration, `production status` may report only the expected
   `schema-mismatch`; confirm the selected database is new/empty separately.
2. Enable the provider backup policy, record its identifier and retention, then
   run the guarded forward migration exactly once. A repeated run must report
   the same applied target without a down/reset operation.
3. Require `production status` outcome `restricted-empty`, one private Launch
   row, one disabled checkout flag, and zero inconsistency counts.
4. Provision only the approved Google subjects with explicit expiry and limits.
   Require `restricted-ready` and matching allowed-user/active-grant counts.
5. After synthetic encrypted save/reload, record increased encrypted-object and
   nonce counts without recording identifiers, keys, ciphertext, or content.

Command syntax and target guards are in
[`production-operations-runbook.md`](production-operations-runbook.md).

## Backup and recovery

Record the database backup identifier/capture time/retention, object-versioning
state, KMS key versions required by the backup, and the isolated temporary
restore target. Restore only into that isolated target with outbound providers
disabled. Verify schema/checksum, aggregate counts, encrypted-object read and
AAD integrity, tenant denial, and KMS fail-closed behavior. Record cleanup state
for the temporary target; cleanup failure is an incident, not a successful
drill. Never destroy an old KMS version while a retained backup depends on it.

For the first empty database, do not claim a preexisting-data backup. Record the
empty check, migration, synthetic encrypted write, provider backup, and isolated
restore in that order.

## Deployment and smoke matrix

Before routing, verify `/healthz` succeeds and `/readyz` is unavailable until
the exact migrated schema is reachable. Keep the origin behind the selected
ingress and do not grant unauthenticated direct-origin invocation unless the
reviewed domain/edge architecture requires it and the server-side gate remains
enforced.

After restricted traffic starts, record these assertions against the immutable
runtime digest:

- approved Google subject completes callback, creates/edits a note, reloads the
  decrypted note, and observes it from a second browser context;
- ciphertext is stored privately and the process can decrypt it after restart;
- unauthenticated, unlisted, wrong-origin/CSRF, forged Cookie/header, and another
  Vault's requests are rejected;
- direct-origin requests cannot bypass authentication, Launch gate, entitlement,
  or ownership;
- checkout is closed and no Stripe object, email, or other external side effect
  is created;
- startup, request-error, PostgreSQL, object-storage, KMS, and backup-failure
  signals reach the approved log/alert destination without secret or content
  fields.

## Stop and recovery controls

Record the exact reviewed provider commands for these operations before
cutover:

1. **Stop public access** — remove/disable the production route or set traffic
   to zero while retaining the deployment and all state.
2. **Stop writes** — use the same no-traffic control for this first release;
   there is no partial read-only mode. Confirm in-flight requests drain within
   the configured shutdown timeout.
3. **Code recovery** — route only to a retained immutable Go digest proven
   compatible with the current schema and ciphertext/key versions.
4. **Data recovery** — keep traffic stopped, preserve DB/object/key evidence,
   and use a separately reviewed forward repair or isolated-restore decision.

Do not automatically route new PostgreSQL writes back to Sites/D1. Never roll
back a migration destructively, delete ciphertext, discard nonce reservations,
restore a revoked session, or destroy a key as a recovery shortcut.

## Final authorization record

Immediately before provider mutation, attach the owner approval that identifies
the source SHA, image digests, schema/checksum, selected resources, expected
cost, allowed-user audit references, exact operations, and recovery commands.
GitHub-required review and branch protection remain mandatory. General public
access, new billing checkout, destructive migration, key destruction, and
resource deletion remain outside this restricted-release approval.
