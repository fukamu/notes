import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const specPath = resolve(repositoryRoot, 'contracts/openapi.yaml');
const fixtureRoot = resolve(repositoryRoot, 'contracts/fixtures');
/** @type {Set<string>} */
const requiredProfiles = new Set([
  'account-handler-contracts',
  'billing-handler-current-main',
  'entitlement-offline-lease-v1',
  'envelope-aes-256-gcm-v1',
  'legacy-sync-v1',
  'legacy-sync-v1-rejections',
  'session-core',
  'sync-v2-handler',
  'terms-consent-v1',
]);

const spec = await readFile(specPath, 'utf8');
for (const marker of [
  'openapi: 3.0.3',
  'f423da9932163980485ecc5bc2055b7c8c3b3d8b',
  '/api/sync:',
  '/api/v2/sync:',
  '/api/session-context:',
  '/api/billing/checkout:',
  '/api/account/deletion:',
  '/api/account/privacy-requests:',
  'x-handler-contract: account-deletion-start',
  'x-handler-contract: account-deletion-resume-one-step',
  'x-fukamu-state: connected-local-fixture-production-closed',
  'x-handler-contract: sync-v2',
  'SyncV2Mutation:',
  'propertyName: kind',
  "upsert: '#/components/schemas/SyncV2UpsertMutation'",
  "resolve: '#/components/schemas/SyncV2ResolveMutation'",
  'x-handler-contract: authenticated-session-context',
  'x-handler-contract: billing-cancellation-period-end',
  'x-go-handler: backend/internal/httpapi/billing_cancellation.go',
  'AccountDeletionResponse:',
  "in-progress: '#/components/schemas/AccountDeletionInProgress'",
  "retry-wait: '#/components/schemas/AccountDeletionRetryWait'",
  "completed: '#/components/schemas/AccountDeletionCompleted'",
]) {
  if (!spec.includes(marker))
    throw new Error(`OpenAPI marker missing: ${marker}`);
}

const accountDeletionStartPath = pathContract(spec, '/api/account/deletion');
const accountDeletionResumePath = pathContract(
  spec,
  '/api/account/deletion/status',
);
const privacyRequestSubmitPath = pathContract(
  spec,
  '/api/account/privacy-requests',
);
const privacyRequestStatusPath = pathContract(
  spec,
  '/api/account/privacy-requests/status',
);
assertMarkers('account deletion Start path', accountDeletionStartPath, [
  'x-fukamu-state: connected-local-fixture-production-closed',
  'x-handler-contract: account-deletion-start',
  '#/components/schemas/AccountDeletionStartRequest',
  '#/components/schemas/AccountDeletionResponse',
  "'202':",
  "'401':",
  "'403':",
  "'404':",
  "'409':",
  "'413':",
]);
assertMarkers('account deletion Resume path', accountDeletionResumePath, [
  'x-fukamu-state: connected-local-fixture-production-closed',
  'x-handler-contract: account-deletion-resume-one-step',
  '#/components/schemas/AccountDeletionResumeRequest',
  '#/components/schemas/AccountDeletionResponse',
  "'200':",
  "'202':",
  "'401':",
  "'403':",
  "'413':",
  '#/components/responses/ContinuationRequired',
]);
assertMarkers('privacy request Submit path', privacyRequestSubmitPath, [
  'x-fukamu-state: connected-local-fixture-production-closed',
  'x-handler-contract: privacy-request-submit',
  '#/components/schemas/PrivacyRequestSubmitRequest',
  '#/components/schemas/PrivacyRequestResponse',
  "'200':",
  "'202':",
  "'400':",
  "'401':",
  "'403':",
  "'404':",
  "'409':",
  "'413':",
  "'503':",
]);
assertMarkers('privacy request Status path', privacyRequestStatusPath, [
  'x-fukamu-state: connected-local-fixture-production-closed',
  'x-handler-contract: privacy-request-status',
  '#/components/schemas/PrivacyRequestStatusRequest',
  '#/components/schemas/PrivacyRequestResponse',
  "'200':",
  "'202':",
  "'400':",
  "'401':",
  "'403':",
  "'404':",
  "'413':",
  "'503':",
]);

const syncV2Mutation = componentSchema(spec, 'SyncV2Mutation');
const syncV2Upsert = componentSchema(spec, 'SyncV2UpsertMutation');
const syncV2Resolve = componentSchema(spec, 'SyncV2ResolveMutation');
const syncV2Request = componentSchema(spec, 'SyncV2Request');
const legacyServerCard = componentSchema(spec, 'ServerCard');
const legacyConflict = componentSchema(spec, 'Conflict');
const syncV2ServerCard = componentSchema(spec, 'SyncV2ServerCard');
const syncV2Conflict = componentSchema(spec, 'SyncV2Conflict');
const syncV2Change = componentSchema(spec, 'SyncV2Change');
const syncV2Receipt = componentSchema(spec, 'SyncV2MutationReceipt');
const accountDeletionKey = componentSchema(
  spec,
  'AccountDeletionIdempotencyKey',
);
const accountDeletionToken = componentSchema(
  spec,
  'AccountDeletionContinuationToken',
);
const accountDeletionStart = componentSchema(
  spec,
  'AccountDeletionStartRequest',
);
const accountDeletionResume = componentSchema(
  spec,
  'AccountDeletionResumeRequest',
);
const accountDeletionResponse = componentSchema(
  spec,
  'AccountDeletionResponse',
);
const authenticationRequiredError = componentSchema(
  spec,
  'AuthenticationRequiredError',
);
const continuationRequiredError = componentSchema(
  spec,
  'ContinuationRequiredError',
);
const privacyRequestSubmit = componentSchema(
  spec,
  'PrivacyRequestSubmitRequest',
);
const privacyRequestStatus = componentSchema(
  spec,
  'PrivacyRequestStatusRequest',
);
const privacyRequestResponse = componentSchema(spec, 'PrivacyRequestResponse');
const privacyRequestCompletedFulfilled = componentSchema(
  spec,
  'PrivacyRequestCompletedFulfilled',
);
const privacyRequestCompletedDeletion = componentSchema(
  spec,
  'PrivacyRequestCompletedDeletionHandoff',
);
const sessionContext = componentSchema(spec, 'SessionContext');
assertMarkers('SyncV2Mutation', syncV2Mutation, [
  '#/components/schemas/SyncV2UpsertMutation',
  '#/components/schemas/SyncV2ResolveMutation',
  'propertyName: kind',
]);
assertMarkers('SyncV2UpsertMutation', syncV2Upsert, [
  'additionalProperties: false',
  'nullable: true',
  'minimum: 1',
  'maximum: 2147483647',
  'enum: [upsert]',
  'maxItems: 0',
]);
assertMarkers('SyncV2ResolveMutation', syncV2Resolve, [
  'additionalProperties: false',
  'minimum: 1',
  'maximum: 2147483647',
  'enum: [resolve]',
  'minItems: 1',
  'maxItems: 500',
  'uniqueItems: true',
]);
if (syncV2Resolve.includes('nullable: true')) {
  throw new Error(
    'SyncV2ResolveMutation baseServerRevision must not be nullable',
  );
}
assertMarkers('SyncV2Request', syncV2Request, [
  'mutationId values must be unique within the request',
  "items: { $ref: '#/components/schemas/SyncV2Mutation' }",
]);
assertMarkers('legacy ServerCard', legacyServerCard, [
  'revision: { type: integer, minimum: 1, maximum: 9007199254740991 }',
]);
assertMarkers('legacy Conflict', legacyConflict, [
  'serverRevision: { type: integer, minimum: 1, maximum: 9007199254740991 }',
]);
assertMarkers('SyncV2ServerCard', syncV2ServerCard, [
  'revision: { type: integer, minimum: 1, maximum: 2147483647 }',
]);
assertMarkers('SyncV2Conflict', syncV2Conflict, [
  'serverRevision: { type: integer, minimum: 1, maximum: 2147483647 }',
]);
assertMarkers('SyncV2Change', syncV2Change, [
  "card: { $ref: '#/components/schemas/SyncV2ServerCard' }",
  "conflict: { $ref: '#/components/schemas/SyncV2Conflict' }",
  'revision: { type: integer, minimum: 1, maximum: 2147483647 }',
]);
assertMarkers('SyncV2MutationReceipt', syncV2Receipt, [
  '{ type: integer, minimum: 1, maximum: 2147483647 }',
]);
assertMarkers('AccountDeletionIdempotencyKey', accountDeletionKey, [
  'minLength: 43',
  'maxLength: 43',
  "pattern: '^[A-Za-z0-9_-]{43}$'",
]);
assertMarkers('AccountDeletionContinuationToken', accountDeletionToken, [
  'minLength: 49',
  'maxLength: 58',
  "pattern: '^ad1\\.[A-Za-z0-9_-]{43}\\.(?:0|[1-9][0-9]{0,8}|1[0-9]{9}|20[0-9]{8}|21[0-3][0-9]{7}|214[0-6][0-9]{6}|2147[0-3][0-9]{5}|21474[0-7][0-9]{4}|214748[0-2][0-9]{3}|2147483[0-5][0-9]{2}|21474836[0-3][0-9]|214748364[0-7])$'",
]);
assertMarkers('AccountDeletionStartRequest', accountDeletionStart, [
  'additionalProperties: false',
  'required: [idempotencyKey]',
  '#/components/schemas/AccountDeletionIdempotencyKey',
]);
assertMarkers('AccountDeletionResumeRequest', accountDeletionResume, [
  'additionalProperties: false',
  'required: [continuationToken]',
  '#/components/schemas/AccountDeletionContinuationToken',
]);
assertMarkers('AccountDeletionResponse', accountDeletionResponse, [
  '#/components/schemas/AccountDeletionInProgress',
  '#/components/schemas/AccountDeletionRetryWait',
  '#/components/schemas/AccountDeletionFailed',
  '#/components/schemas/AccountDeletionCompleted',
  'propertyName: status',
]);
assertMarkers('AuthenticationRequiredError', authenticationRequiredError, [
  'additionalProperties: false',
  'required: [error]',
  'error: { type: string, enum: [authentication-required] }',
]);
assertMarkers('ContinuationRequiredError', continuationRequiredError, [
  'additionalProperties: false',
  'required: [error]',
  'error: { type: string, enum: [continuation-required] }',
]);
assertMarkers('PrivacyRequestSubmitRequest', privacyRequestSubmit, [
  'additionalProperties: false',
  'required: [submissionId, requestKind]',
  "submissionId: { $ref: '#/components/schemas/UuidV7' }",
  "requestKind: { $ref: '#/components/schemas/PrivacyRequestKind' }",
]);
assertMarkers('PrivacyRequestStatusRequest', privacyRequestStatus, [
  'additionalProperties: false',
  'required: [requestId]',
  "requestId: { $ref: '#/components/schemas/UuidV7' }",
]);
assertMarkers('PrivacyRequestResponse', privacyRequestResponse, [
  '#/components/schemas/PrivacyRequestVerificationPending',
  '#/components/schemas/PrivacyRequestReady',
  '#/components/schemas/PrivacyRequestProcessing',
  '#/components/schemas/PrivacyRequestCompletedFulfilled',
  '#/components/schemas/PrivacyRequestCompletedDeletionHandoff',
  '#/components/schemas/PrivacyRequestRejected',
  '#/components/schemas/PrivacyRequestFailed',
  'updatedAt is at or after requestedAt',
]);
assertMarkers(
  'PrivacyRequestCompletedFulfilled',
  privacyRequestCompletedFulfilled,
  [
    'additionalProperties: false',
    'requestKind:',
    "{ $ref: '#/components/schemas/PrivacyRequestNonDeletionKind' }",
    'status: { type: string, enum: [completed] }',
    'outcome: { type: string, enum: [fulfilled] }',
  ],
);
assertMarkers(
  'PrivacyRequestCompletedDeletionHandoff',
  privacyRequestCompletedDeletion,
  [
    'additionalProperties: false',
    'requestKind: { type: string, enum: [deletion] }',
    'status: { type: string, enum: [completed] }',
    'outcome: { type: string, enum: [account-deletion-started] }',
  ],
);
for (const [name, literal] of [
  ['PrivacyRequestInvalidRequestError', 'invalid-request'],
  ['PrivacyRequestForbiddenError', 'forbidden'],
  ['PrivacyRequestNotFoundError', 'not-found'],
  ['PrivacyRequestConflictError', 'request-conflict'],
  ['PrivacyRequestTooLargeError', 'request-too-large'],
  ['PrivacyRequestUnavailableError', 'unavailable'],
]) {
  assertMarkers(name, componentSchema(spec, name), [
    'additionalProperties: false',
    'required: [error]',
    `error: { type: string, enum: [${literal}] }`,
  ]);
}
assertMarkers(
  'AuthenticationRequired response',
  componentResponse(spec, 'AuthenticationRequired'),
  [
    '#/components/schemas/AuthenticationRequiredError',
    'example: { error: authentication-required }',
  ],
);
assertMarkers(
  'ContinuationRequired response',
  componentResponse(spec, 'ContinuationRequired'),
  [
    '#/components/schemas/ContinuationRequiredError',
    'example: { error: continuation-required }',
  ],
);
assertMarkers('SessionContext', sessionContext, [
  'additionalProperties: false',
  'accountDeletionAvailable',
  'accountDeletionAvailable: { type: boolean }',
]);

const files = await jsonFiles(fixtureRoot);
if (files.length === 0) throw new Error('No migration contract fixtures found');
/** @type {Set<string>} */
const profiles = new Set();
/** @type {{ path: string, sha256: string }[]} */
const digests = [];
for (const path of files) {
  const bytes = await readFile(path);
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new Error(`${relative(repositoryRoot, path)} must not contain a BOM`);
  }
  const source = bytes.toString('utf8');
  /** @type {unknown} */
  const value = JSON.parse(source);
  if (!isRecord(value) || typeof value.profile !== 'string') {
    throw new Error(`${relative(repositoryRoot, path)} must declare profile`);
  }
  if (profiles.has(value.profile)) {
    throw new Error(`Duplicate fixture profile: ${value.profile}`);
  }
  profiles.add(value.profile);
  digests.push({
    path: relative(repositoryRoot, path),
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
}
for (const profile of requiredProfiles) {
  if (!profiles.has(profile))
    throw new Error(`Fixture profile missing: ${profile}`);
}

process.stdout.write(
  `${JSON.stringify({
    openapi: '3.0.3',
    specSha256: createHash('sha256').update(spec).digest('hex'),
    fixtures: digests,
  })}\n`,
);

/**
 * @param {string} root
 * @returns {Promise<string[]>}
 */
async function jsonFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  /** @type {string[][]} */
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(root, entry.name);
      if (entry.isDirectory()) return jsonFiles(path);
      return entry.isFile() && entry.name.endsWith('.json') ? [path] : [];
    }),
  );
  return nested.flat().sort();
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {string} source
 * @param {string} name
 * @returns {string}
 */
function componentSchema(source, name) {
  const schemasStart = source.indexOf('\n  schemas:\n');
  if (schemasStart < 0) throw new Error('OpenAPI components.schemas missing');
  const marker = `    ${name}:\n`;
  const start = source.indexOf(marker, schemasStart);
  if (start < 0) throw new Error(`OpenAPI component missing: ${name}`);
  const remainder = source.slice(start + marker.length);
  const next = remainder.search(/^    [A-Za-z0-9_-]+:\n/m);
  return next < 0 ? remainder : remainder.slice(0, next);
}

/**
 * @param {string} source
 * @param {string} name
 * @returns {string}
 */
function componentResponse(source, name) {
  const responsesStart = source.indexOf('\n  responses:\n');
  const schemasStart = source.indexOf('\n  schemas:\n');
  if (
    responsesStart < 0 ||
    schemasStart < 0 ||
    schemasStart <= responsesStart
  ) {
    throw new Error('OpenAPI components.responses missing');
  }
  const marker = `    ${name}:\n`;
  const start = source.indexOf(marker, responsesStart);
  if (start < 0 || start >= schemasStart) {
    throw new Error(`OpenAPI response missing: ${name}`);
  }
  const remainder = source.slice(start + marker.length, schemasStart);
  const next = remainder.search(/^    [A-Za-z0-9_-]+:\n/m);
  return next < 0 ? remainder : remainder.slice(0, next);
}

/**
 * @param {string} source
 * @param {string} name
 * @returns {string}
 */
function pathContract(source, name) {
  const marker = `  ${name}:\n`;
  const start = source.indexOf(marker);
  if (start < 0) throw new Error(`OpenAPI path missing: ${name}`);
  const remainder = source.slice(start + marker.length);
  const next = remainder.search(/^  \/api\//m);
  return next < 0 ? remainder : remainder.slice(0, next);
}

/**
 * @param {string} name
 * @param {string} source
 * @param {readonly string[]} markers
 */
function assertMarkers(name, source, markers) {
  for (const marker of markers) {
    if (!source.includes(marker)) {
      throw new Error(`OpenAPI ${name} invariant missing: ${marker}`);
    }
  }
}
