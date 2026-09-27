# Restricted production on Cloud Run

This document turns the reviewed production composition into a concrete Google
Cloud Run release package. It does not contain credentials, create a provider
resource, apply a migration, or authorize spend. The real values file and
rendered manifests belong under ignored `outputs/`; do not commit them.

The first release uses one Go runtime service and one separately pinned
`notesctl` job. The runtime and operations job use different Google service
accounts and different PostgreSQL credentials. There is no permanent staging
service and no Node.js process in either production image.

## Required owner values

Do not run the provider commands until the release packet records all of these:

- Google Cloud project ID and number, billing account, region, monthly cost
  ceiling, operator identity, and alert destination;
- exact HTTPS origin: either the deterministic Cloud Run URL
  `https://<service>-<project-number>.<region>.run.app` or an approved custom
  domain;
- managed PostgreSQL provider, plan, region, database name, runtime pooled TLS
  URL, operations direct TLS URL, backup/restore window, and separate roles;
- Google OAuth web client ID and Secret Manager version, with the exact
  `<origin>/auth/google/callback` redirect registered;
- initial verified Google `sub`, limited-grant expiry and limits;
- private bucket name, full enabled KMS key-version resource, and pinned Secret
  Manager versions;
- immutable runtime and operations image digests built from the approved main
  SHA.

The current small-service recommendation is Cloud Run request-based billing in
`asia-southeast1`, minimum zero, maximum two instances, concurrency 20, one
vCPU, and 512 MiB. The PostgreSQL choice remains explicit: Neon Launch provides
a longer restore window and usage billing, while Neon Free has tighter storage,
compute, egress, and restore limits and no production SLA. A Free database must
not be recorded as equivalent backup or availability evidence.

## Runtime boundary

Cloud Run must accept unauthenticated HTTPS requests because the browser must
reach the public legal pages and begin Google OIDC. The service template uses
the provider's `invoker-iam-disabled` setting for that network entry. This does
**not** open Notes: every session, Sync v2, content, entitlement, and checkout
request is still authenticated and authorized by Go, and the PostgreSQL Launch
gate remains private. An unlisted Google subject and a request sent directly to
the `run.app` origin reach the same Go enforcement and cannot bypass it.

`billing-checkout` remains false. Even an accidental true value still has no
production Stripe composition, so the route fails closed instead of charging.
Public Launch mode and a real billing provider are separate future changes.

The runtime service account receives only:

- Secret Manager accessor on the pinned runtime-database, OIDC-client-secret,
  and cursor-HMAC secrets;
- Storage Object User on the one private ciphertext bucket;
- Cloud KMS CryptoKey Encrypter/Decrypter on the one content key.

The operations service account receives only Secret Manager accessor on the
operations-database secret and CryptoKey Encrypter/Decrypter on the content key.
It receives no Cloud Run administration role and no bucket role for the initial
status/migrate/access commands. The human or CI deployer needs Cloud Run and
Artifact Registry deployment permissions plus Service Account User on these
identities; those permissions are not granted to either workload.

## PostgreSQL boundary

Use a new, empty PostgreSQL database with TLS required. The operations URL uses
a direct endpoint and a schema-owner/migration role so the Goose session lock
is tied to one database connection. The runtime URL may use the provider's
pooled endpoint and a non-owner role. Keep both URLs in separate secrets.

After migration, grant the runtime role `CONNECT` on the database, `USAGE` on
the application schema, and only the table/sequence privileges needed by the Go
runtime. Set default privileges for objects subsequently created by the
operations owner. Do not grant schema ownership, role administration, database
creation, or migration DDL to the runtime role. Record the reviewed SQL in the
provider change record, not in a connection string or this repository.

For a new empty database, the evidence order is: empty check, backup policy,
guarded forward migration, runtime grants, `restricted-empty` status, access
provisioning, encrypted synthetic write, provider backup, and isolated restore.
Never use `prepare-e2e`, schema reset, or a down migration.

## Build and render

Build both targets from the same exact main commit and push them to the approved
regional Artifact Registry repository. A mutable tag can be used only as the
push handle; obtain and record each resulting digest before rendering:

```sh
docker buildx build --platform linux/amd64 --target runtime \
  --build-arg NOTES_SOURCE_REVISION=<main-sha> \
  --tag <region>-docker.pkg.dev/<project>/<repository>/runtime:<main-sha> \
  --push -f deploy/Dockerfile .

docker buildx build --platform linux/amd64 --target notesctl \
  --build-arg NOTES_SOURCE_REVISION=<main-sha> \
  --tag <region>-docker.pkg.dev/<project>/<repository>/notesctl:<main-sha> \
  --push -f deploy/Dockerfile .
```

Copy `deploy/cloud-run/production.values.example.json` to a release-specific
file under `outputs/`, replace every example value with the reviewed non-secret
value or pinned secret reference, and render new files. The renderer rejects
mutable image tags, `latest` secrets, local/test profiles, reused runtime and
operations identities, unknown fields, and overwriting existing evidence.

```sh
npm run check:cloud-run-production

node --experimental-strip-types scripts/render-cloud-run-production.mts \
  --values outputs/<release>/production.values.json \
  --output outputs/<release>/cloud-run
```

The example check validates repository templates only. It is not evidence that
the real account, secret versions, images, IAM, database, bucket, or key exist.

## Resource setup and IAM

Create resources only in the approved project and region. Use the following as
the reviewed command shape; substitute the recorded names and do not place
secret values on a command line:

```sh
gcloud services enable run.googleapis.com artifactregistry.googleapis.com \
  secretmanager.googleapis.com storage.googleapis.com cloudkms.googleapis.com \
  monitoring.googleapis.com --project=<project>

gcloud iam service-accounts create notes-runtime --project=<project>
gcloud iam service-accounts create notes-operations --project=<project>

gcloud storage buckets create gs://<bucket> --project=<project> \
  --location=<region> --uniform-bucket-level-access
gcloud storage buckets update gs://<bucket> --versioning

gcloud kms keyrings create notes --project=<project> --location=<region>
gcloud kms keys create content --project=<project> --location=<region> \
  --keyring=notes --purpose=encryption \
  --default-algorithm=google-symmetric-encryption
```

Set the approved KMS automatic-rotation schedule without disabling or destroying
old versions. Updating `kmsKeyVersion` later changes only new DEK writes; stored
DEKs retain their version reference and still require old versions to decrypt.

Add IAM bindings on the individual bucket, KMS key, and secrets, not broad
project-wide workload roles. Pin numeric Secret Manager versions in the values
file. When a secret changes, add a new version, render a new immutable manifest,
deploy and verify it, then disable an old version only after confirming no
retained revision or operation depends on it.

## Guarded operations job

Install the rendered job definition without executing it:

```sh
gcloud run jobs replace outputs/<release>/cloud-run/operations.job.yaml \
  --project=<project> --region=<region>
```

Its default arguments intentionally fail closed because they omit the required
target confirmations and observation time. Every execution overrides all
arguments, runs one task with zero retries, and waits for a terminal result.
The database URL remains a pinned secret reference.

```sh
gcloud run jobs execute <operations-job> --project=<project> --region=<region> \
  --wait \
  --args="production,status,--environment=production,--observed-at-millis=<unix-ms>,--expected-database-host=<host>,--expected-database-name=<database>,--confirm-production-read-only"

gcloud run jobs execute <operations-job> --project=<project> --region=<region> \
  --wait \
  --args="migrate,--environment=production,--expected-database-host=<host>,--expected-database-name=<database>,--confirm-production-forward"

gcloud run jobs execute <operations-job> --project=<project> --region=<region> \
  --wait \
  --args="access,provision,--environment=production,--issuer=https://accounts.google.com,--subject=<verified-sub>,--granted-at-millis=<unix-ms>,--expires-at-millis=<unix-ms>,--active-cards=<count>,--display-characters-per-card=<count>,--serialized-plaintext-bytes-per-card=<bytes>,--plaintext-bytes-per-vault=<bytes>,--expected-database-host=<host>,--expected-database-name=<database>,--confirm-production-access-mutation,--confirm-kms-encrypt"
```

The first status against an empty database is expected to fail with only
`schema-mismatch`. After migration it must be `restricted-empty`; after the
approved user is provisioned it must be `restricted-ready`. Store only the
redacted command result and Cloud Run execution reference in the release packet.
The provider subject can appear in the access-controlled job execution audit
record, but never in repository files, general telemetry labels, or the release
packet.

## Service deploy and smoke

Register the exact OAuth callback before starting the service. Replace the
service from the rendered manifest only after schema and gate preflight pass:

```sh
gcloud run services replace outputs/<release>/cloud-run/runtime.service.yaml \
  --project=<project> --region=<region>
```

This is the first Go release, so there is no prior compatible Go revision to
receive traffic. The revision may receive HTTPS traffic while the application
Launch gate remains restricted. Immediately verify the deployed digest and
revision, `/healthz`, `/readyz`, and `production status`, then complete the
release packet smoke matrix:

1. an unauthenticated API request is rejected;
2. an unlisted Google account cannot enter Notes;
3. the listed account logs in, creates and edits one synthetic note, reloads
   its decrypted body, and observes it in a second clean browser context;
4. a restarted instance reads the same note and aggregate status shows encrypted
   object plus nonce evidence without exposing content;
5. a forged Cookie/header, wrong Origin/CSRF request, and another Vault scope are
   rejected;
6. `POST /api/billing/checkout` remains closed and no Stripe object or external
   message is created.

Use Cloud Logging and Cloud Monitoring for the initial minimal alerts: revision
startup failure, sustained 5xx responses, PostgreSQL/KMS/GCS dependency errors,
and provider backup failure. Alert destination and retention are owner values;
do not create a placeholder second reviewer or destination.

## Stop, revoke, and recover

To stop browser access without deleting the service or data, re-enable the Cloud
Run Invoker IAM check. This blocks the public web entry while retaining every
revision, database row, ciphertext, nonce, wrapped key, and secret version:

```sh
gcloud run services update <service> --project=<project> --region=<region> \
  --invoker-iam-check
```

Wait for in-flight requests to drain through the configured ten-second Go
shutdown window. There is no partial read-only mode in the first release, so
this is also the write-stop control. Reopen the network entry only with
`--no-invoker-iam-check` after preflight and smoke are healthy.

Revoke one Notes user through the operations job with `access,revoke`, the exact
issuer/subject, timestamp, database target, and
`--confirm-production-access-mutation`. Revocation is effective on the next
server request and revokes active server sessions; it cannot remotely erase
offline browser data already downloaded to a device.

Code recovery routes only to a retained immutable Go digest proven compatible
with schema 18 and the current ciphertext/key versions. On database, storage,
KMS, or integrity uncertainty, keep public access stopped and preserve all
state. Restore only into an isolated temporary target, verify schema/checksums,
encrypted read/AAD, user separation and fail-closed behavior, then choose a
reviewed forward repair. Never run a down migration, destroy an old key version,
delete ciphertext/nonces, or route new PostgreSQL writes back to Sites/D1.
