import {
  planCheckoutCreation,
  planReconciliationSnapshot,
  planVerifiedProviderFact,
  toBillingSubscriptionFacts,
} from './core';
import type { BillingOwnershipPort, BillingRepository } from './ports';
import type {
  BillingApi,
  BillingCommandResult,
  ProviderFactResult,
} from './public';

export function createBillingApi(input: {
  readonly ownership: BillingOwnershipPort;
  readonly repository: BillingRepository;
}): BillingApi {
  return {
    async beginCheckout(context, command): Promise<BillingCommandResult> {
      if (!(await input.ownership.owns(context))) {
        return { kind: 'rejected', reason: 'owner-mismatch' };
      }
      const plan = planCheckoutCreation(context, command);
      if (plan.kind === 'rejected') return plan;
      const intent = {
        checkoutIntentId: command.checkoutIntentId,
        subscriptionId: command.subscriptionId,
        provider: command.provider,
        providerCheckoutReference: null,
        status: 'created',
        createdAt: command.createdAt,
        openedAt: null,
      } as const;
      const result = await input.repository.createCheckout({
        record: plan.record,
        intent,
      });
      if (result.kind === 'created') {
        return {
          kind: 'applied',
          facts: toBillingSubscriptionFacts(plan.record),
        };
      }
      if (
        result.record !== undefined &&
        result.intent !== undefined &&
        sameCheckout(result.record, result.intent, plan.record, intent)
      ) {
        return {
          kind: 'replayed',
          facts: toBillingSubscriptionFacts(result.record),
        };
      }
      return { kind: 'rejected', reason: 'identifier-conflict' };
    },

    async recordCheckoutOpened(context, command) {
      if (!(await input.ownership.owns(context))) {
        return { kind: 'rejected', reason: 'owner-mismatch' };
      }
      const [record, existing] = await Promise.all([
        input.repository.findByOwner(context),
        input.repository.findCheckoutIntent(command.checkoutIntentId),
      ]);
      if (
        record === undefined ||
        existing === undefined ||
        record.subscriptionId !== command.subscriptionId ||
        existing.subscriptionId !== command.subscriptionId
      ) {
        return { kind: 'rejected', reason: 'not-found' };
      }
      const mappedCheckout =
        await input.repository.findCheckoutByProviderReference(
          existing.provider,
          command.providerCheckoutReference,
        );
      if (
        mappedCheckout !== undefined &&
        mappedCheckout.checkoutIntentId !== command.checkoutIntentId
      ) {
        return { kind: 'rejected', reason: 'identifier-conflict' };
      }
      if (
        !Number.isSafeInteger(command.openedAt) ||
        command.openedAt < existing.createdAt
      ) {
        return { kind: 'rejected', reason: 'invalid-transition' };
      }
      const result = await input.repository.openCheckout({
        context,
        intent: {
          ...existing,
          providerCheckoutReference: command.providerCheckoutReference,
          status: 'opened',
          openedAt: command.openedAt,
        },
      });
      if (result.kind === 'conflict') {
        return { kind: 'rejected', reason: 'identifier-conflict' };
      }
      return {
        kind: result.kind === 'applied' ? 'applied' : 'replayed',
        facts: toBillingSubscriptionFacts(record),
      };
    },

    async ingestVerifiedProviderFact(fact): Promise<ProviderFactResult> {
      const [current, mapped] = await Promise.all([
        input.repository.findById(fact.subscriptionId),
        input.repository.findByProviderMapping({
          provider: fact.provider,
          customerReference: fact.providerCustomerReference,
          subscriptionReference: fact.providerSubscriptionReference,
        }),
      ]);
      if (current === undefined) {
        return { kind: 'rejected', reason: 'not-found' };
      }
      if (
        mapped !== undefined &&
        mapped.subscriptionId !== fact.subscriptionId
      ) {
        return { kind: 'rejected', reason: 'mapping-mismatch' };
      }
      const existing = await input.repository.findProviderEventReceipt(
        fact.provider,
        fact.eventId,
      );
      if (existing !== undefined) {
        return existing.subscriptionId === current.subscriptionId
          ? { kind: 'duplicate', facts: toBillingSubscriptionFacts(current) }
          : { kind: 'rejected', reason: 'mapping-mismatch' };
      }
      const plan = planVerifiedProviderFact(current, fact);
      if (plan.kind === 'rejected') return plan;
      const receipt = {
        provider: fact.provider,
        eventId: fact.eventId,
        subscriptionId: fact.subscriptionId,
        factKind: fact.kind,
        outcome: plan.kind === 'apply' ? 'applied' : 'ignored',
        occurredAt: fact.occurredAt,
        appliedVersion: plan.record.version,
        recordedAt: fact.recordedAt,
      } as const;
      if (plan.kind === 'ignore') {
        const stored =
          await input.repository.recordIgnoredProviderFact(receipt);
        return stored.kind === 'duplicate'
          ? { kind: 'duplicate', facts: toBillingSubscriptionFacts(current) }
          : {
              kind: 'ignored',
              reason: plan.reason,
              facts: toBillingSubscriptionFacts(plan.record),
            };
      }
      const committed = await input.repository.commitProviderFact({
        expectedRecord: current,
        nextRecord: plan.record,
        receipt,
      });
      return commitResult(
        committed,
        plan.record,
        async () =>
          (await input.repository.findById(fact.subscriptionId)) ?? current,
      );
    },

    async reconcileVerifiedSnapshot(snapshot): Promise<ProviderFactResult> {
      const [current, mapped] = await Promise.all([
        input.repository.findById(snapshot.subscriptionId),
        input.repository.findByProviderMapping({
          provider: snapshot.provider,
          customerReference: snapshot.providerCustomerReference,
          subscriptionReference: snapshot.providerSubscriptionReference,
        }),
      ]);
      if (current === undefined) {
        return { kind: 'rejected', reason: 'not-found' };
      }
      if (
        mapped !== undefined &&
        mapped.subscriptionId !== snapshot.subscriptionId
      ) {
        return { kind: 'rejected', reason: 'mapping-mismatch' };
      }
      const existing = await input.repository.findReconciliationCheckpoint(
        snapshot.provider,
        snapshot.snapshotId,
      );
      if (existing !== undefined) {
        return existing.subscriptionId === current.subscriptionId
          ? { kind: 'duplicate', facts: toBillingSubscriptionFacts(current) }
          : { kind: 'rejected', reason: 'mapping-mismatch' };
      }
      const plan = planReconciliationSnapshot(current, snapshot);
      if (plan.kind === 'rejected') return plan;
      const checkpoint = {
        provider: snapshot.provider,
        snapshotId: snapshot.snapshotId,
        subscriptionId: snapshot.subscriptionId,
        observedAt: snapshot.observedAt,
        appliedVersion: plan.record.version,
        recordedAt: snapshot.recordedAt,
      };
      if (plan.kind === 'ignore') {
        const stored =
          await input.repository.recordIgnoredReconciliation(checkpoint);
        return stored.kind === 'duplicate'
          ? { kind: 'duplicate', facts: toBillingSubscriptionFacts(current) }
          : {
              kind: 'ignored',
              reason: plan.reason,
              facts: toBillingSubscriptionFacts(plan.record),
            };
      }
      const committed = await input.repository.commitReconciliation({
        expectedRecord: current,
        nextRecord: plan.record,
        checkpoint,
      });
      return commitResult(
        committed,
        plan.record,
        async () =>
          (await input.repository.findById(snapshot.subscriptionId)) ?? current,
      );
    },

    async readSubscription(context) {
      if (!(await input.ownership.owns(context))) return undefined;
      const record = await input.repository.findByOwner(context);
      return record === undefined
        ? undefined
        : toBillingSubscriptionFacts(record);
    },
  };
}

function sameCheckout(
  existingRecord: Parameters<typeof toBillingSubscriptionFacts>[0],
  existingIntent: Parameters<BillingRepository['createCheckout']>[0]['intent'],
  proposedRecord: Parameters<typeof toBillingSubscriptionFacts>[0],
  proposedIntent: Parameters<BillingRepository['createCheckout']>[0]['intent'],
): boolean {
  return (
    existingRecord.subscriptionId === proposedRecord.subscriptionId &&
    existingRecord.accountId === proposedRecord.accountId &&
    existingRecord.vaultId === proposedRecord.vaultId &&
    existingRecord.provider === proposedRecord.provider &&
    existingIntent.checkoutIntentId === proposedIntent.checkoutIntentId &&
    existingIntent.subscriptionId === proposedIntent.subscriptionId &&
    existingIntent.provider === proposedIntent.provider &&
    existingIntent.createdAt === proposedIntent.createdAt
  );
}

async function commitResult(
  result: Awaited<ReturnType<BillingRepository['commitProviderFact']>>,
  planned: Parameters<typeof toBillingSubscriptionFacts>[0],
  readCurrent: () => Promise<Parameters<typeof toBillingSubscriptionFacts>[0]>,
): Promise<ProviderFactResult> {
  switch (result.kind) {
    case 'applied':
      return { kind: 'applied', facts: toBillingSubscriptionFacts(planned) };
    case 'duplicate':
      return {
        kind: 'duplicate',
        facts: toBillingSubscriptionFacts(await readCurrent()),
      };
    case 'conflict':
      return { kind: 'rejected', reason: 'cas-conflict' };
  }
}
