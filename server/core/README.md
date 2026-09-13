# Server pure core

Provider-neutral server decisions, codecs, state transitions, and operation
plans belong here. Code in this directory is included in the API typecheck,
unsafe lint, architecture tests, and coverage collection.

This core must not read clocks or environment variables, generate identifiers,
perform network or storage I/O, use Cloudflare/Stripe/KMS APIs, or import
`server/adapters`. Adapters must decode external values and pass typed inputs
inward.
