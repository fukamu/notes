package operations

const (
	maximumOperationalTimestamp int64 = 9_007_199_254_740_991
	LaunchGateEvidenceVersion         = 1
)

type OperationEnvironment string

const (
	EnvironmentLocal      OperationEnvironment = "local"
	EnvironmentTest       OperationEnvironment = "test"
	EnvironmentStaging    OperationEnvironment = "staging"
	EnvironmentProduction OperationEnvironment = "production"
)

type OperationalAction string

const (
	ActionFixtureDrill        OperationalAction = "fixture-drill"
	ActionRestoreDrill        OperationalAction = "restore-drill"
	ActionCanaryEntry         OperationalAction = "canary-entry"
	ActionCanaryPromote       OperationalAction = "canary-promote"
	ActionCanaryAbort         OperationalAction = "canary-abort"
	ActionCodeRollback        OperationalAction = "code-rollback"
	ActionDataRestore         OperationalAction = "data-restore"
	ActionDataDelete          OperationalAction = "data-delete"
	ActionKeyDestruction      OperationalAction = "key-destruction"
	ActionWebhookRegistration OperationalAction = "webhook-registration"
	ActionAlertConfiguration  OperationalAction = "alert-configuration"
)

type ProductionOperationApproval string

const ExplicitProductionOperationApprovalRequired ProductionOperationApproval = "explicit-production-operation-approval-required"

type EnvironmentActionPlanKind string

const (
	EnvironmentActionFixtureOnly                           EnvironmentActionPlanKind = "fixture-only"
	EnvironmentActionLaunchGateRequired                    EnvironmentActionPlanKind = "launch-gate-required"
	EnvironmentActionLaunchGateAndExplicitApprovalRequired EnvironmentActionPlanKind = "launch-gate-and-explicit-approval-required"
	EnvironmentActionBlocked                               EnvironmentActionPlanKind = "blocked"
)

type EnvironmentActionBlockReason string

const (
	EnvironmentActionFixtureOutsideFixtureEnvironment           EnvironmentActionBlockReason = "fixture-action-outside-fixture-environment"
	EnvironmentActionNonFixtureInFixtureEnvironment             EnvironmentActionBlockReason = "non-fixture-action-in-fixture-environment"
	EnvironmentActionIsolatedStagingRestoreRequired             EnvironmentActionBlockReason = "isolated-staging-restore-required"
	EnvironmentActionDestructiveOutsideLaunchWorkflow           EnvironmentActionBlockReason = "destructive-action-outside-launch-workflow"
	EnvironmentActionProviderConfigurationOutsideLaunchWorkflow EnvironmentActionBlockReason = "provider-configuration-outside-launch-workflow"
	EnvironmentActionInvalidEnvironment                         EnvironmentActionBlockReason = "invalid-operation-environment"
	EnvironmentActionInvalidAction                              EnvironmentActionBlockReason = "invalid-operational-action"
)

type EnvironmentActionInput struct {
	Environment OperationEnvironment
	Action      OperationalAction
}

type EnvironmentActionPlan struct {
	Kind     EnvironmentActionPlanKind
	Reason   EnvironmentActionBlockReason
	Approval ProductionOperationApproval
}

func PlanEnvironmentAction(input EnvironmentActionInput) EnvironmentActionPlan {
	if !validOperationEnvironment(input.Environment) {
		return blockedEnvironmentAction(EnvironmentActionInvalidEnvironment)
	}
	if !validOperationalAction(input.Action) {
		return blockedEnvironmentAction(EnvironmentActionInvalidAction)
	}

	switch input.Action {
	case ActionFixtureDrill:
		if input.Environment == EnvironmentLocal || input.Environment == EnvironmentTest {
			return EnvironmentActionPlan{Kind: EnvironmentActionFixtureOnly}
		}
		return blockedEnvironmentAction(EnvironmentActionFixtureOutsideFixtureEnvironment)
	case ActionRestoreDrill:
		if input.Environment == EnvironmentStaging {
			return EnvironmentActionPlan{Kind: EnvironmentActionLaunchGateRequired}
		}
		if input.Environment == EnvironmentProduction {
			return blockedEnvironmentAction(EnvironmentActionIsolatedStagingRestoreRequired)
		}
		return blockedEnvironmentAction(EnvironmentActionNonFixtureInFixtureEnvironment)
	case ActionDataDelete, ActionKeyDestruction:
		return blockedEnvironmentAction(EnvironmentActionDestructiveOutsideLaunchWorkflow)
	case ActionWebhookRegistration, ActionAlertConfiguration:
		return blockedEnvironmentAction(EnvironmentActionProviderConfigurationOutsideLaunchWorkflow)
	case ActionCanaryEntry, ActionCanaryPromote, ActionCanaryAbort, ActionCodeRollback, ActionDataRestore:
		switch input.Environment {
		case EnvironmentLocal, EnvironmentTest:
			return blockedEnvironmentAction(EnvironmentActionNonFixtureInFixtureEnvironment)
		case EnvironmentStaging:
			return EnvironmentActionPlan{Kind: EnvironmentActionLaunchGateRequired}
		case EnvironmentProduction:
			return EnvironmentActionPlan{
				Kind:     EnvironmentActionLaunchGateAndExplicitApprovalRequired,
				Approval: ExplicitProductionOperationApprovalRequired,
			}
		default:
			return blockedEnvironmentAction(EnvironmentActionInvalidEnvironment)
		}
	default:
		return blockedEnvironmentAction(EnvironmentActionInvalidAction)
	}
}

func blockedEnvironmentAction(reason EnvironmentActionBlockReason) EnvironmentActionPlan {
	return EnvironmentActionPlan{Kind: EnvironmentActionBlocked, Reason: reason}
}

func validOperationEnvironment(environment OperationEnvironment) bool {
	switch environment {
	case EnvironmentLocal, EnvironmentTest, EnvironmentStaging, EnvironmentProduction:
		return true
	default:
		return false
	}
}

func validOperationalAction(action OperationalAction) bool {
	switch action {
	case ActionFixtureDrill,
		ActionRestoreDrill,
		ActionCanaryEntry,
		ActionCanaryPromote,
		ActionCanaryAbort,
		ActionCodeRollback,
		ActionDataRestore,
		ActionDataDelete,
		ActionKeyDestruction,
		ActionWebhookRegistration,
		ActionAlertConfiguration:
		return true
	default:
		return false
	}
}

type LaunchGateEnvironment string

const (
	LaunchGateStaging    LaunchGateEnvironment = "staging"
	LaunchGateProduction LaunchGateEnvironment = "production"
)

type LaunchGateAction string

const (
	LaunchActionRestoreDrill  LaunchGateAction = "restore-drill"
	LaunchActionCanaryEntry   LaunchGateAction = "canary-entry"
	LaunchActionCanaryPromote LaunchGateAction = "canary-promote"
	LaunchActionCanaryAbort   LaunchGateAction = "canary-abort"
	LaunchActionCodeRollback  LaunchGateAction = "code-rollback"
	LaunchActionDataRestore   LaunchGateAction = "data-restore"
)

type TargetConfirmation string

const (
	TargetUnconfirmed TargetConfirmation = "unconfirmed"
	TargetConfirmed   TargetConfirmation = "confirmed"
)

type ChangeApproval string

const (
	ChangeApprovalMissing                     ChangeApproval = "missing"
	ChangeApprovalStagingApproved             ChangeApproval = "staging-approved"
	ChangeApprovalProductionTwoPersonApproved ChangeApproval = "production-two-person-approved"
)

type OperationReview string

const (
	ReviewSingleOperator     OperationReview = "single-operator"
	ReviewTwoPersonConfirmed OperationReview = "two-person-confirmed"
)

type BackupEvidence string

const (
	BackupMissing     BackupEvidence = "missing"
	BackupNotRequired BackupEvidence = "not-required"
	BackupVerified    BackupEvidence = "verified"
)

type RollbackWindowKind string

const (
	RollbackWindowMissing RollbackWindowKind = "missing"
	RollbackWindowOpen    RollbackWindowKind = "open"
)

type RollbackWindow struct {
	Kind     RollbackWindowKind
	ClosesAt int64
}

type TelemetryReadiness string

const (
	TelemetryNotReady TelemetryReadiness = "not-ready"
	TelemetryReady    TelemetryReadiness = "ready"
)

type OperationalDecisionState string

const (
	OperationalDecisionRequired OperationalDecisionState = "decision-required"
	OperationalDecisionResolved OperationalDecisionState = "resolved"
)

type MigrationSafety string

const (
	MigrationNone               MigrationSafety = "none"
	MigrationBackwardCompatible MigrationSafety = "backward-compatible"
	MigrationDestructive        MigrationSafety = "destructive"
)

type CanaryEvidence string

const (
	CanaryNotApplicable CanaryEvidence = "not-applicable"
	CanaryObserved      CanaryEvidence = "observed"
	CanaryAborted       CanaryEvidence = "aborted"
)

type IsolatedRestoreEvidence string

const (
	IsolatedRestoreNotApplicable IsolatedRestoreEvidence = "not-applicable"
	IsolatedRestoreMissing       IsolatedRestoreEvidence = "missing"
	IsolatedRestoreVerified      IsolatedRestoreEvidence = "verified"
)

type LaunchGateEvidence struct {
	SchemaVersion   int
	Environment     LaunchGateEnvironment
	Action          LaunchGateAction
	Target          TargetConfirmation
	ChangeApproval  ChangeApproval
	Review          OperationReview
	Backup          BackupEvidence
	RollbackWindow  RollbackWindow
	Telemetry       TelemetryReadiness
	Decisions       OperationalDecisionState
	Migration       MigrationSafety
	Canary          CanaryEvidence
	IsolatedRestore IsolatedRestoreEvidence
	CheckedAt       int64
}

type LaunchGateBlockReason string

const (
	LaunchGateInvalidEvidence                     LaunchGateBlockReason = "invalid-launch-gate-evidence"
	LaunchGateTargetUnconfirmed                   LaunchGateBlockReason = "target-unconfirmed"
	LaunchGateIsolatedStagingRestoreRequired      LaunchGateBlockReason = "isolated-staging-restore-required"
	LaunchGateChangeApprovalMissing               LaunchGateBlockReason = "change-approval-missing"
	LaunchGateTwoPersonReviewRequired             LaunchGateBlockReason = "two-person-review-required"
	LaunchGateBackupEvidenceRequired              LaunchGateBlockReason = "backup-evidence-required"
	LaunchGateRollbackWindowMissing               LaunchGateBlockReason = "rollback-window-missing"
	LaunchGateRollbackWindowClosed                LaunchGateBlockReason = "rollback-window-closed"
	LaunchGateTelemetryNotReady                   LaunchGateBlockReason = "telemetry-not-ready"
	LaunchGateOperationalDecisionRequired         LaunchGateBlockReason = "operational-decision-required"
	LaunchGateDestructiveMigrationOutsideWorkflow LaunchGateBlockReason = "destructive-migration-outside-launch-workflow"
	LaunchGateCanaryObservationRequired           LaunchGateBlockReason = "canary-observation-required"
	LaunchGateCanaryAborted                       LaunchGateBlockReason = "canary-aborted"
	LaunchGateIsolatedRestoreEvidenceRequired     LaunchGateBlockReason = "isolated-restore-evidence-required"
)

type LaunchGatePlanKind string

const (
	LaunchGateBlocked                  LaunchGatePlanKind = "blocked"
	LaunchGateReady                    LaunchGatePlanKind = "ready"
	LaunchGateExplicitApprovalRequired LaunchGatePlanKind = "explicit-approval-required"
)

type LaunchGatePlan struct {
	Kind        LaunchGatePlanKind
	Reasons     []LaunchGateBlockReason
	Environment LaunchGateEnvironment
	Action      LaunchGateAction
	Approval    ProductionOperationApproval
}

func EvaluateLaunchGate(evidence LaunchGateEvidence) LaunchGatePlan {
	if !ValidLaunchGateEvidence(evidence) {
		return LaunchGatePlan{
			Kind:    LaunchGateBlocked,
			Reasons: []LaunchGateBlockReason{LaunchGateInvalidEvidence},
		}
	}

	reasons := make([]LaunchGateBlockReason, 0, 8)
	isAbort := evidence.Action == LaunchActionCanaryAbort

	if evidence.Target != TargetConfirmed {
		reasons = append(reasons, LaunchGateTargetUnconfirmed)
	}
	if evidence.Environment == LaunchGateProduction && evidence.Action == LaunchActionRestoreDrill {
		reasons = append(reasons, LaunchGateIsolatedStagingRestoreRequired)
	}
	if (evidence.Environment == LaunchGateStaging && evidence.ChangeApproval != ChangeApprovalStagingApproved) ||
		(evidence.Environment == LaunchGateProduction && evidence.ChangeApproval != ChangeApprovalProductionTwoPersonApproved) {
		reasons = append(reasons, LaunchGateChangeApprovalMissing)
	}
	if evidence.Environment == LaunchGateProduction && evidence.Review != ReviewTwoPersonConfirmed {
		reasons = append(reasons, LaunchGateTwoPersonReviewRequired)
	}

	backupRequired := !isAbort && (evidence.Action == LaunchActionRestoreDrill ||
		evidence.Action == LaunchActionDataRestore || evidence.Migration != MigrationNone)
	if backupRequired && evidence.Backup != BackupVerified {
		reasons = append(reasons, LaunchGateBackupEvidenceRequired)
	}

	if !isAbort {
		switch evidence.RollbackWindow.Kind {
		case RollbackWindowMissing:
			reasons = append(reasons, LaunchGateRollbackWindowMissing)
		case RollbackWindowOpen:
			if evidence.RollbackWindow.ClosesAt <= evidence.CheckedAt {
				reasons = append(reasons, LaunchGateRollbackWindowClosed)
			}
		default:
			return LaunchGatePlan{
				Kind:    LaunchGateBlocked,
				Reasons: []LaunchGateBlockReason{LaunchGateInvalidEvidence},
			}
		}
		if evidence.Telemetry != TelemetryReady {
			reasons = append(reasons, LaunchGateTelemetryNotReady)
		}
		if evidence.Decisions != OperationalDecisionResolved {
			reasons = append(reasons, LaunchGateOperationalDecisionRequired)
		}
		if evidence.Migration == MigrationDestructive {
			reasons = append(reasons, LaunchGateDestructiveMigrationOutsideWorkflow)
		}
	}

	if evidence.Action == LaunchActionCanaryPromote {
		switch evidence.Canary {
		case CanaryAborted:
			reasons = append(reasons, LaunchGateCanaryAborted)
		case CanaryObserved:
		case CanaryNotApplicable:
			reasons = append(reasons, LaunchGateCanaryObservationRequired)
		default:
			return LaunchGatePlan{
				Kind:    LaunchGateBlocked,
				Reasons: []LaunchGateBlockReason{LaunchGateInvalidEvidence},
			}
		}
	}

	if (evidence.Action == LaunchActionRestoreDrill || evidence.Action == LaunchActionDataRestore) &&
		evidence.IsolatedRestore != IsolatedRestoreVerified {
		reasons = append(reasons, LaunchGateIsolatedRestoreEvidenceRequired)
	}

	if len(reasons) > 0 {
		return LaunchGatePlan{Kind: LaunchGateBlocked, Reasons: reasons}
	}
	if evidence.Environment == LaunchGateStaging {
		return LaunchGatePlan{
			Kind: LaunchGateReady, Environment: LaunchGateStaging, Action: evidence.Action,
		}
	}
	return LaunchGatePlan{
		Kind: LaunchGateExplicitApprovalRequired, Environment: LaunchGateProduction,
		Action: evidence.Action, Approval: ExplicitProductionOperationApprovalRequired,
	}
}

func ValidLaunchGateEvidence(evidence LaunchGateEvidence) bool {
	return evidence.SchemaVersion == LaunchGateEvidenceVersion &&
		validLaunchGateEnvironment(evidence.Environment) &&
		validLaunchGateAction(evidence.Action) &&
		validTargetConfirmation(evidence.Target) &&
		validChangeApproval(evidence.ChangeApproval) &&
		validOperationReview(evidence.Review) &&
		validBackupEvidence(evidence.Backup) &&
		validRollbackWindow(evidence.RollbackWindow) &&
		validTelemetryReadiness(evidence.Telemetry) &&
		validOperationalDecisionState(evidence.Decisions) &&
		validMigrationSafety(evidence.Migration) &&
		validCanaryEvidence(evidence.Canary) &&
		validIsolatedRestoreEvidence(evidence.IsolatedRestore) &&
		validOperationalTimestamp(evidence.CheckedAt)
}

func validLaunchGateEnvironment(environment LaunchGateEnvironment) bool {
	return environment == LaunchGateStaging || environment == LaunchGateProduction
}

func validLaunchGateAction(action LaunchGateAction) bool {
	switch action {
	case LaunchActionRestoreDrill,
		LaunchActionCanaryEntry,
		LaunchActionCanaryPromote,
		LaunchActionCanaryAbort,
		LaunchActionCodeRollback,
		LaunchActionDataRestore:
		return true
	default:
		return false
	}
}

func validTargetConfirmation(value TargetConfirmation) bool {
	return value == TargetUnconfirmed || value == TargetConfirmed
}

func validChangeApproval(value ChangeApproval) bool {
	switch value {
	case ChangeApprovalMissing, ChangeApprovalStagingApproved, ChangeApprovalProductionTwoPersonApproved:
		return true
	default:
		return false
	}
}

func validOperationReview(value OperationReview) bool {
	return value == ReviewSingleOperator || value == ReviewTwoPersonConfirmed
}

func validBackupEvidence(value BackupEvidence) bool {
	switch value {
	case BackupMissing, BackupNotRequired, BackupVerified:
		return true
	default:
		return false
	}
}

func validRollbackWindow(value RollbackWindow) bool {
	switch value.Kind {
	case RollbackWindowMissing:
		return value.ClosesAt == 0
	case RollbackWindowOpen:
		return validOperationalTimestamp(value.ClosesAt)
	default:
		return false
	}
}

func validTelemetryReadiness(value TelemetryReadiness) bool {
	return value == TelemetryNotReady || value == TelemetryReady
}

func validOperationalDecisionState(value OperationalDecisionState) bool {
	return value == OperationalDecisionRequired || value == OperationalDecisionResolved
}

func validMigrationSafety(value MigrationSafety) bool {
	switch value {
	case MigrationNone, MigrationBackwardCompatible, MigrationDestructive:
		return true
	default:
		return false
	}
}

func validCanaryEvidence(value CanaryEvidence) bool {
	switch value {
	case CanaryNotApplicable, CanaryObserved, CanaryAborted:
		return true
	default:
		return false
	}
}

func validIsolatedRestoreEvidence(value IsolatedRestoreEvidence) bool {
	switch value {
	case IsolatedRestoreNotApplicable, IsolatedRestoreMissing, IsolatedRestoreVerified:
		return true
	default:
		return false
	}
}

func validOperationalTimestamp(value int64) bool {
	return value >= 0 && value <= maximumOperationalTimestamp
}
