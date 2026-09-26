package operations

import (
	"reflect"
	"testing"
)

func TestPlanEnvironmentActionClassifiesCompleteMatrix(t *testing.T) {
	t.Parallel()
	fixture := EnvironmentActionPlan{Kind: EnvironmentActionFixtureOnly}
	gate := EnvironmentActionPlan{Kind: EnvironmentActionLaunchGateRequired}
	approval := EnvironmentActionPlan{
		Kind:     EnvironmentActionLaunchGateAndExplicitApprovalRequired,
		Approval: ExplicitProductionOperationApprovalRequired,
	}
	blocked := func(reason EnvironmentActionBlockReason) EnvironmentActionPlan {
		return EnvironmentActionPlan{Kind: EnvironmentActionBlocked, Reason: reason}
	}

	matrix := map[OperationEnvironment]map[OperationalAction]EnvironmentActionPlan{
		EnvironmentLocal: {
			ActionFixtureDrill:        fixture,
			ActionRestoreDrill:        blocked(EnvironmentActionNonFixtureInFixtureEnvironment),
			ActionCanaryEntry:         blocked(EnvironmentActionNonFixtureInFixtureEnvironment),
			ActionCanaryPromote:       blocked(EnvironmentActionNonFixtureInFixtureEnvironment),
			ActionCanaryAbort:         blocked(EnvironmentActionNonFixtureInFixtureEnvironment),
			ActionCodeRollback:        blocked(EnvironmentActionNonFixtureInFixtureEnvironment),
			ActionDataRestore:         blocked(EnvironmentActionNonFixtureInFixtureEnvironment),
			ActionDataDelete:          blocked(EnvironmentActionDestructiveOutsideLaunchWorkflow),
			ActionKeyDestruction:      blocked(EnvironmentActionDestructiveOutsideLaunchWorkflow),
			ActionWebhookRegistration: blocked(EnvironmentActionProviderConfigurationOutsideLaunchWorkflow),
			ActionAlertConfiguration:  blocked(EnvironmentActionProviderConfigurationOutsideLaunchWorkflow),
		},
		EnvironmentTest: {
			ActionFixtureDrill:        fixture,
			ActionRestoreDrill:        blocked(EnvironmentActionNonFixtureInFixtureEnvironment),
			ActionCanaryEntry:         blocked(EnvironmentActionNonFixtureInFixtureEnvironment),
			ActionCanaryPromote:       blocked(EnvironmentActionNonFixtureInFixtureEnvironment),
			ActionCanaryAbort:         blocked(EnvironmentActionNonFixtureInFixtureEnvironment),
			ActionCodeRollback:        blocked(EnvironmentActionNonFixtureInFixtureEnvironment),
			ActionDataRestore:         blocked(EnvironmentActionNonFixtureInFixtureEnvironment),
			ActionDataDelete:          blocked(EnvironmentActionDestructiveOutsideLaunchWorkflow),
			ActionKeyDestruction:      blocked(EnvironmentActionDestructiveOutsideLaunchWorkflow),
			ActionWebhookRegistration: blocked(EnvironmentActionProviderConfigurationOutsideLaunchWorkflow),
			ActionAlertConfiguration:  blocked(EnvironmentActionProviderConfigurationOutsideLaunchWorkflow),
		},
		EnvironmentStaging: {
			ActionFixtureDrill:        blocked(EnvironmentActionFixtureOutsideFixtureEnvironment),
			ActionRestoreDrill:        gate,
			ActionCanaryEntry:         gate,
			ActionCanaryPromote:       gate,
			ActionCanaryAbort:         gate,
			ActionCodeRollback:        gate,
			ActionDataRestore:         gate,
			ActionDataDelete:          blocked(EnvironmentActionDestructiveOutsideLaunchWorkflow),
			ActionKeyDestruction:      blocked(EnvironmentActionDestructiveOutsideLaunchWorkflow),
			ActionWebhookRegistration: blocked(EnvironmentActionProviderConfigurationOutsideLaunchWorkflow),
			ActionAlertConfiguration:  blocked(EnvironmentActionProviderConfigurationOutsideLaunchWorkflow),
		},
		EnvironmentProduction: {
			ActionFixtureDrill:        blocked(EnvironmentActionFixtureOutsideFixtureEnvironment),
			ActionRestoreDrill:        blocked(EnvironmentActionIsolatedStagingRestoreRequired),
			ActionCanaryEntry:         approval,
			ActionCanaryPromote:       approval,
			ActionCanaryAbort:         approval,
			ActionCodeRollback:        approval,
			ActionDataRestore:         approval,
			ActionDataDelete:          blocked(EnvironmentActionDestructiveOutsideLaunchWorkflow),
			ActionKeyDestruction:      blocked(EnvironmentActionDestructiveOutsideLaunchWorkflow),
			ActionWebhookRegistration: blocked(EnvironmentActionProviderConfigurationOutsideLaunchWorkflow),
			ActionAlertConfiguration:  blocked(EnvironmentActionProviderConfigurationOutsideLaunchWorkflow),
		},
	}

	environments := []OperationEnvironment{
		EnvironmentLocal,
		EnvironmentTest,
		EnvironmentStaging,
		EnvironmentProduction,
	}
	actions := []OperationalAction{
		ActionFixtureDrill,
		ActionRestoreDrill,
		ActionCanaryEntry,
		ActionCanaryPromote,
		ActionCanaryAbort,
		ActionCodeRollback,
		ActionDataRestore,
		ActionDataDelete,
		ActionKeyDestruction,
		ActionWebhookRegistration,
		ActionAlertConfiguration,
	}

	for _, environment := range environments {
		for _, action := range actions {
			input := EnvironmentActionInput{Environment: environment, Action: action}
			if got, want := PlanEnvironmentAction(input), matrix[environment][action]; got != want {
				t.Errorf("PlanEnvironmentAction(%#v) = %#v, want %#v", input, got, want)
			}
		}
	}
}

func TestPlanEnvironmentActionFailsClosedForUnknownStates(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name  string
		input EnvironmentActionInput
		want  EnvironmentActionBlockReason
	}{
		{
			name:  "zero environment",
			input: EnvironmentActionInput{Action: ActionCanaryEntry},
			want:  EnvironmentActionInvalidEnvironment,
		},
		{
			name:  "unknown environment",
			input: EnvironmentActionInput{Environment: "preview", Action: ActionCanaryEntry},
			want:  EnvironmentActionInvalidEnvironment,
		},
		{
			name:  "zero action",
			input: EnvironmentActionInput{Environment: EnvironmentStaging},
			want:  EnvironmentActionInvalidAction,
		},
		{
			name:  "unknown action",
			input: EnvironmentActionInput{Environment: EnvironmentProduction, Action: "deploy"},
			want:  EnvironmentActionInvalidAction,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			got := PlanEnvironmentAction(test.input)
			want := EnvironmentActionPlan{Kind: EnvironmentActionBlocked, Reason: test.want}
			if got != want {
				t.Fatalf("PlanEnvironmentAction(%#v) = %#v, want %#v", test.input, got, want)
			}
		})
	}
}

func TestEvaluateLaunchGateAcceptsEveryCompleteStagingAction(t *testing.T) {
	t.Parallel()
	actions := []LaunchGateAction{
		LaunchActionRestoreDrill,
		LaunchActionCanaryEntry,
		LaunchActionCanaryPromote,
		LaunchActionCanaryAbort,
		LaunchActionCodeRollback,
		LaunchActionDataRestore,
	}
	for _, action := range actions {
		action := action
		t.Run(string(action), func(t *testing.T) {
			t.Parallel()
			evidence := completeLaunchGateEvidence()
			evidence.Action = action
			if action == LaunchActionRestoreDrill || action == LaunchActionDataRestore {
				evidence.Backup = BackupVerified
				evidence.IsolatedRestore = IsolatedRestoreVerified
			}
			if action == LaunchActionCanaryPromote {
				evidence.Canary = CanaryObserved
			}
			want := LaunchGatePlan{Kind: LaunchGateReady, Environment: LaunchGateStaging, Action: action}
			if got := EvaluateLaunchGate(evidence); !reflect.DeepEqual(got, want) {
				t.Fatalf("EvaluateLaunchGate() = %#v, want %#v", got, want)
			}
		})
	}
}

func TestEvaluateLaunchGateNeverTurnsProductionReadinessIntoPermission(t *testing.T) {
	t.Parallel()
	actions := []LaunchGateAction{
		LaunchActionCanaryEntry,
		LaunchActionCanaryPromote,
		LaunchActionCanaryAbort,
		LaunchActionCodeRollback,
		LaunchActionDataRestore,
	}
	for _, action := range actions {
		action := action
		t.Run(string(action), func(t *testing.T) {
			t.Parallel()
			evidence := completeLaunchGateEvidence()
			evidence.Environment = LaunchGateProduction
			evidence.Action = action
			evidence.ChangeApproval = ChangeApprovalProductionTwoPersonApproved
			evidence.Review = ReviewTwoPersonConfirmed
			if action == LaunchActionCanaryPromote {
				evidence.Canary = CanaryObserved
			}
			if action == LaunchActionDataRestore {
				evidence.Backup = BackupVerified
				evidence.IsolatedRestore = IsolatedRestoreVerified
			}
			want := LaunchGatePlan{
				Kind: LaunchGateExplicitApprovalRequired, Environment: LaunchGateProduction,
				Action: action, Approval: ExplicitProductionOperationApprovalRequired,
			}
			if got := EvaluateLaunchGate(evidence); !reflect.DeepEqual(got, want) {
				t.Fatalf("EvaluateLaunchGate() = %#v, want %#v", got, want)
			}
		})
	}
}

func TestEvaluateLaunchGateReturnsDeterministicProductionBlockers(t *testing.T) {
	t.Parallel()
	evidence := completeLaunchGateEvidence()
	evidence.Environment = LaunchGateProduction
	evidence.Target = TargetUnconfirmed
	evidence.ChangeApproval = ChangeApprovalMissing
	evidence.Review = ReviewSingleOperator
	evidence.Backup = BackupMissing
	evidence.RollbackWindow = RollbackWindow{Kind: RollbackWindowMissing}
	evidence.Telemetry = TelemetryNotReady
	evidence.Decisions = OperationalDecisionRequired
	evidence.Migration = MigrationDestructive

	want := LaunchGatePlan{
		Kind: LaunchGateBlocked,
		Reasons: []LaunchGateBlockReason{
			LaunchGateTargetUnconfirmed,
			LaunchGateChangeApprovalMissing,
			LaunchGateTwoPersonReviewRequired,
			LaunchGateBackupEvidenceRequired,
			LaunchGateRollbackWindowMissing,
			LaunchGateTelemetryNotReady,
			LaunchGateOperationalDecisionRequired,
			LaunchGateDestructiveMigrationOutsideWorkflow,
		},
	}
	if got := EvaluateLaunchGate(evidence); !reflect.DeepEqual(got, want) {
		t.Fatalf("EvaluateLaunchGate() = %#v, want %#v", got, want)
	}
	if got := EvaluateLaunchGate(evidence); !reflect.DeepEqual(got, want) {
		t.Fatalf("repeated EvaluateLaunchGate() = %#v, want %#v", got, want)
	}
}

func TestEvaluateLaunchGateRequiresOpenRollbackAndObservedCanary(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name    string
		window  RollbackWindow
		canary  CanaryEvidence
		reasons []LaunchGateBlockReason
	}{
		{
			name:   "window closes at check time",
			window: RollbackWindow{Kind: RollbackWindowOpen, ClosesAt: 1_000},
			canary: CanaryNotApplicable,
			reasons: []LaunchGateBlockReason{
				LaunchGateRollbackWindowClosed,
				LaunchGateCanaryObservationRequired,
			},
		},
		{
			name:    "canary aborted",
			window:  RollbackWindow{Kind: RollbackWindowOpen, ClosesAt: 2_000},
			canary:  CanaryAborted,
			reasons: []LaunchGateBlockReason{LaunchGateCanaryAborted},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			evidence := completeLaunchGateEvidence()
			evidence.Action = LaunchActionCanaryPromote
			evidence.RollbackWindow = test.window
			evidence.Canary = test.canary
			want := LaunchGatePlan{Kind: LaunchGateBlocked, Reasons: test.reasons}
			if got := EvaluateLaunchGate(evidence); !reflect.DeepEqual(got, want) {
				t.Fatalf("EvaluateLaunchGate() = %#v, want %#v", got, want)
			}
		})
	}
}

func TestEvaluateLaunchGateRequiresBackupAndIsolatedRestoreEvidence(t *testing.T) {
	t.Parallel()
	evidence := completeLaunchGateEvidence()
	evidence.Action = LaunchActionDataRestore
	evidence.Backup = BackupMissing
	evidence.IsolatedRestore = IsolatedRestoreMissing
	want := LaunchGatePlan{
		Kind: LaunchGateBlocked,
		Reasons: []LaunchGateBlockReason{
			LaunchGateBackupEvidenceRequired,
			LaunchGateIsolatedRestoreEvidenceRequired,
		},
	}
	if got := EvaluateLaunchGate(evidence); !reflect.DeepEqual(got, want) {
		t.Fatalf("EvaluateLaunchGate() = %#v, want %#v", got, want)
	}

	production := completeLaunchGateEvidence()
	production.Environment = LaunchGateProduction
	production.Action = LaunchActionRestoreDrill
	production.ChangeApproval = ChangeApprovalProductionTwoPersonApproved
	production.Review = ReviewTwoPersonConfirmed
	production.Backup = BackupVerified
	production.IsolatedRestore = IsolatedRestoreVerified
	want = LaunchGatePlan{
		Kind:    LaunchGateBlocked,
		Reasons: []LaunchGateBlockReason{LaunchGateIsolatedStagingRestoreRequired},
	}
	if got := EvaluateLaunchGate(production); !reflect.DeepEqual(got, want) {
		t.Fatalf("production restore EvaluateLaunchGate() = %#v, want %#v", got, want)
	}
}

func TestEvaluateLaunchGateAllowsReviewedAbortWithoutRecoveryEvidence(t *testing.T) {
	t.Parallel()
	evidence := completeLaunchGateEvidence()
	evidence.Environment = LaunchGateProduction
	evidence.Action = LaunchActionCanaryAbort
	evidence.ChangeApproval = ChangeApprovalProductionTwoPersonApproved
	evidence.Review = ReviewTwoPersonConfirmed
	evidence.Backup = BackupMissing
	evidence.RollbackWindow = RollbackWindow{Kind: RollbackWindowMissing}
	evidence.Telemetry = TelemetryNotReady
	evidence.Decisions = OperationalDecisionRequired
	evidence.Migration = MigrationDestructive
	evidence.Canary = CanaryAborted
	want := LaunchGatePlan{
		Kind: LaunchGateExplicitApprovalRequired, Environment: LaunchGateProduction,
		Action: LaunchActionCanaryAbort, Approval: ExplicitProductionOperationApprovalRequired,
	}
	if got := EvaluateLaunchGate(evidence); !reflect.DeepEqual(got, want) {
		t.Fatalf("EvaluateLaunchGate() = %#v, want %#v", got, want)
	}
}

func TestEvaluateLaunchGateRequiresBackupForAnyMigration(t *testing.T) {
	t.Parallel()
	for _, migration := range []MigrationSafety{MigrationBackwardCompatible, MigrationDestructive} {
		migration := migration
		t.Run(string(migration), func(t *testing.T) {
			t.Parallel()
			evidence := completeLaunchGateEvidence()
			evidence.Migration = migration
			evidence.Backup = BackupNotRequired
			wantReasons := []LaunchGateBlockReason{LaunchGateBackupEvidenceRequired}
			if migration == MigrationDestructive {
				wantReasons = append(wantReasons, LaunchGateDestructiveMigrationOutsideWorkflow)
			}
			want := LaunchGatePlan{Kind: LaunchGateBlocked, Reasons: wantReasons}
			if got := EvaluateLaunchGate(evidence); !reflect.DeepEqual(got, want) {
				t.Fatalf("EvaluateLaunchGate() = %#v, want %#v", got, want)
			}
		})
	}
}

func TestEvaluateLaunchGateFailsClosedForEveryInvalidEvidenceField(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name   string
		mutate func(*LaunchGateEvidence)
	}{
		{name: "schema zero", mutate: func(value *LaunchGateEvidence) { value.SchemaVersion = 0 }},
		{name: "schema future", mutate: func(value *LaunchGateEvidence) { value.SchemaVersion = 2 }},
		{name: "environment", mutate: func(value *LaunchGateEvidence) { value.Environment = "preview" }},
		{name: "action", mutate: func(value *LaunchGateEvidence) { value.Action = "deploy" }},
		{name: "target", mutate: func(value *LaunchGateEvidence) { value.Target = "maybe" }},
		{name: "change approval", mutate: func(value *LaunchGateEvidence) { value.ChangeApproval = "approved" }},
		{name: "review", mutate: func(value *LaunchGateEvidence) { value.Review = "unknown" }},
		{name: "backup", mutate: func(value *LaunchGateEvidence) { value.Backup = "unknown" }},
		{name: "rollback kind", mutate: func(value *LaunchGateEvidence) { value.RollbackWindow.Kind = "closed" }},
		{name: "missing rollback with timestamp", mutate: func(value *LaunchGateEvidence) {
			value.RollbackWindow = RollbackWindow{Kind: RollbackWindowMissing, ClosesAt: 1}
		}},
		{name: "negative rollback timestamp", mutate: func(value *LaunchGateEvidence) { value.RollbackWindow.ClosesAt = -1 }},
		{name: "unsafe rollback timestamp", mutate: func(value *LaunchGateEvidence) {
			value.RollbackWindow.ClosesAt = maximumOperationalTimestamp + 1
		}},
		{name: "telemetry", mutate: func(value *LaunchGateEvidence) { value.Telemetry = "unknown" }},
		{name: "decisions", mutate: func(value *LaunchGateEvidence) { value.Decisions = "unknown" }},
		{name: "migration", mutate: func(value *LaunchGateEvidence) { value.Migration = "unknown" }},
		{name: "canary", mutate: func(value *LaunchGateEvidence) { value.Canary = "unknown" }},
		{name: "isolated restore", mutate: func(value *LaunchGateEvidence) { value.IsolatedRestore = "unknown" }},
		{name: "negative checked at", mutate: func(value *LaunchGateEvidence) { value.CheckedAt = -1 }},
		{name: "unsafe checked at", mutate: func(value *LaunchGateEvidence) {
			value.CheckedAt = maximumOperationalTimestamp + 1
		}},
	}
	want := LaunchGatePlan{
		Kind:    LaunchGateBlocked,
		Reasons: []LaunchGateBlockReason{LaunchGateInvalidEvidence},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			evidence := completeLaunchGateEvidence()
			test.mutate(&evidence)
			if ValidLaunchGateEvidence(evidence) {
				t.Fatal("ValidLaunchGateEvidence() = true")
			}
			if got := EvaluateLaunchGate(evidence); !reflect.DeepEqual(got, want) {
				t.Fatalf("EvaluateLaunchGate() = %#v, want %#v", got, want)
			}
		})
	}
}

func completeLaunchGateEvidence() LaunchGateEvidence {
	return LaunchGateEvidence{
		SchemaVersion:   LaunchGateEvidenceVersion,
		Environment:     LaunchGateStaging,
		Action:          LaunchActionCanaryEntry,
		Target:          TargetConfirmed,
		ChangeApproval:  ChangeApprovalStagingApproved,
		Review:          ReviewSingleOperator,
		Backup:          BackupNotRequired,
		RollbackWindow:  RollbackWindow{Kind: RollbackWindowOpen, ClosesAt: 2_000},
		Telemetry:       TelemetryReady,
		Decisions:       OperationalDecisionResolved,
		Migration:       MigrationNone,
		Canary:          CanaryNotApplicable,
		IsolatedRestore: IsolatedRestoreNotApplicable,
		CheckedAt:       1_000,
	}
}
