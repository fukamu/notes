import type {
  PrivacyRequestDeletionHandoffPort,
  PrivacyRequestDeletionHandoffResult,
  PrivacyRequestExecutionPort,
  PrivacyRequestExecutionResult,
  PrivacyRequestVerificationPort,
  PrivacyRequestVerificationPortResult,
} from './application';

export class FakePrivacyRequestVerification implements PrivacyRequestVerificationPort {
  readonly calls: Parameters<PrivacyRequestVerificationPort['verify']>[0][] =
    [];

  constructor(private result: PrivacyRequestVerificationPortResult) {}

  setResult(result: PrivacyRequestVerificationPortResult): void {
    this.result = result;
  }

  async verify(
    input: Parameters<PrivacyRequestVerificationPort['verify']>[0],
  ): Promise<PrivacyRequestVerificationPortResult> {
    this.calls.push(input);
    return this.result;
  }
}

export class FakePrivacyRequestExecution implements PrivacyRequestExecutionPort {
  readonly calls: Parameters<PrivacyRequestExecutionPort['execute']>[0][] = [];

  constructor(private result: PrivacyRequestExecutionResult) {}

  setResult(result: PrivacyRequestExecutionResult): void {
    this.result = result;
  }

  async execute(
    input: Parameters<PrivacyRequestExecutionPort['execute']>[0],
  ): Promise<PrivacyRequestExecutionResult> {
    this.calls.push(input);
    return this.result;
  }
}

export class FakePrivacyRequestDeletionHandoff implements PrivacyRequestDeletionHandoffPort {
  readonly calls: Parameters<
    PrivacyRequestDeletionHandoffPort['startExistingAccountDeletionSaga']
  >[0][] = [];

  constructor(private result: PrivacyRequestDeletionHandoffResult) {}

  setResult(result: PrivacyRequestDeletionHandoffResult): void {
    this.result = result;
  }

  async startExistingAccountDeletionSaga(
    input: Parameters<
      PrivacyRequestDeletionHandoffPort['startExistingAccountDeletionSaga']
    >[0],
  ): Promise<PrivacyRequestDeletionHandoffResult> {
    this.calls.push(input);
    return this.result;
  }
}
