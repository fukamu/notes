package operations

import (
	"context"
	"errors"
	"testing"

	"github.com/fukamu/notes/backend/internal/cryptocontent"
	"github.com/fukamu/notes/backend/internal/encryptedobject"
	"github.com/fukamu/notes/backend/internal/identity"
)

func TestDEKReencryptionServiceRunsOneExactBatch(t *testing.T) {
	command := testDEKReencryptionCommand(t)
	keyring := testDEKReencryptionKeyring(t, command.VaultID, command.TargetVersion)
	job := testDEKReencryptionJob(command)
	loader := &dekReencryptionLoaderStub{result: DEKReencryptionScopeLoad{Owned: true, Keyring: &keyring}}
	executor := &dekReencryptionExecutorStub{result: encryptedobject.ReencryptionBatchResult{
		Kind: encryptedobject.ReencryptionBatchPending, Processed: 2, Job: &job,
		Pending: encryptedobject.ReencryptionPageLimit,
	}}
	service, err := NewDEKReencryptionService(loader, executor)
	if err != nil {
		t.Fatal(err)
	}
	result, err := service.Run(context.Background(), command)
	if err != nil || result.Kind != DEKReencryptionPending || result.Processed != 2 ||
		result.TargetVersion != command.TargetVersion || result.Pending != encryptedobject.ReencryptionPageLimit {
		t.Fatalf("result = %#v, error = %v", result, err)
	}
	if loader.calls != 1 || executor.calls != 1 || executor.limit != command.Limit ||
		executor.performedAt != command.PerformedAtMilli || executor.keyring.WriteVersion != command.TargetVersion {
		t.Fatalf("loader calls=%d executor=%#v", loader.calls, executor)
	}
}

func TestDEKReencryptionServiceMapsCompletedAndRefusedResults(t *testing.T) {
	command := testDEKReencryptionCommand(t)
	keyring := testDEKReencryptionKeyring(t, command.VaultID, command.TargetVersion)
	job := testDEKReencryptionJob(command)
	job.State = encryptedobject.ReencryptionCompleted
	tests := []struct {
		name  string
		batch encryptedobject.ReencryptionBatchResult
		want  DEKReencryptionResultKind
	}{
		{
			name: "completed replay",
			batch: encryptedobject.ReencryptionBatchResult{
				Kind: encryptedobject.ReencryptionBatchCompleted, Job: &job,
			},
			want: DEKReencryptionCompleted,
		},
		{
			name: "concurrent conflict",
			batch: encryptedobject.ReencryptionBatchResult{
				Kind:    encryptedobject.ReencryptionBatchPending,
				Pending: encryptedobject.ReencryptionCASConflict,
			},
			want: DEKReencryptionPending,
		},
		{
			name: "inventory refusal",
			batch: encryptedobject.ReencryptionBatchResult{
				Kind:     encryptedobject.ReencryptionBatchRejected,
				Rejected: encryptedobject.ReencryptionNewerVersion,
			},
			want: DEKReencryptionRefused,
		},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			loader := &dekReencryptionLoaderStub{result: DEKReencryptionScopeLoad{Owned: true, Keyring: &keyring}}
			executor := &dekReencryptionExecutorStub{result: testCase.batch}
			service, _ := NewDEKReencryptionService(loader, executor)
			result, err := service.Run(context.Background(), command)
			if err != nil || result.Kind != testCase.want {
				t.Fatalf("result = %#v, error = %v", result, err)
			}
		})
	}
}

func TestDEKReencryptionServiceRefusesScopeAndTargetBeforeEffects(t *testing.T) {
	command := testDEKReencryptionCommand(t)
	tests := []struct {
		name   string
		loaded DEKReencryptionScopeLoad
		reason encryptedobject.ReencryptionRejection
	}{
		{name: "owner missing", reason: encryptedobject.ReencryptionOwnerMissing},
		{
			name: "target mismatch",
			loaded: func() DEKReencryptionScopeLoad {
				keyring := testDEKReencryptionKeyring(t, command.VaultID, 1)
				return DEKReencryptionScopeLoad{Owned: true, Keyring: &keyring}
			}(),
			reason: encryptedobject.ReencryptionTargetMismatch,
		},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			loader := &dekReencryptionLoaderStub{result: testCase.loaded}
			executor := &dekReencryptionExecutorStub{}
			service, _ := NewDEKReencryptionService(loader, executor)
			result, err := service.Run(context.Background(), command)
			if err != nil || result.Kind != DEKReencryptionRefused || result.Reason != testCase.reason ||
				executor.calls != 0 {
				t.Fatalf("result = %#v, error = %v, calls = %d", result, err, executor.calls)
			}
		})
	}
}

func TestDEKReencryptionServiceFailsClosedForErrorsAndMalformedResults(t *testing.T) {
	command := testDEKReencryptionCommand(t)
	keyring := testDEKReencryptionKeyring(t, command.VaultID, command.TargetVersion)
	privateFailure := errors.New("private storage failure")
	loader := &dekReencryptionLoaderStub{result: DEKReencryptionScopeLoad{Owned: true, Keyring: &keyring}}
	executor := &dekReencryptionExecutorStub{err: privateFailure}
	service, _ := NewDEKReencryptionService(loader, executor)
	if result, err := service.Run(context.Background(), command); result != (DEKReencryptionResult{}) ||
		!errors.Is(err, privateFailure) {
		t.Fatalf("failure result = %#v, error = %v", result, err)
	}

	badJob := testDEKReencryptionJob(command)
	badJob.TargetVersion = 3
	executor = &dekReencryptionExecutorStub{result: encryptedobject.ReencryptionBatchResult{
		Kind: encryptedobject.ReencryptionBatchPending, Job: &badJob,
		Pending: encryptedobject.ReencryptionPageLimit,
	}}
	service, _ = NewDEKReencryptionService(loader, executor)
	if result, err := service.Run(context.Background(), command); result != (DEKReencryptionResult{}) ||
		!errors.Is(err, ErrDEKReencryption) {
		t.Fatalf("malformed result = %#v, error = %v", result, err)
	}

	loader = &dekReencryptionLoaderStub{err: context.Canceled}
	service, _ = NewDEKReencryptionService(loader, &dekReencryptionExecutorStub{})
	if _, err := service.Run(context.Background(), command); !errors.Is(err, context.Canceled) {
		t.Fatalf("loader cancellation error = %v", err)
	}
}

func TestDEKReencryptionCommandValidationAndDependencies(t *testing.T) {
	valid := testDEKReencryptionCommand(t)
	tests := []DEKReencryptionCommand{
		{},
		func() DEKReencryptionCommand { value := valid; value.Limit = 0; return value }(),
		func() DEKReencryptionCommand { value := valid; value.Limit = 101; return value }(),
		func() DEKReencryptionCommand { value := valid; value.TargetVersion = 0; return value }(),
		func() DEKReencryptionCommand { value := valid; value.PerformedAtMilli = 0; return value }(),
	}
	for _, invalid := range tests {
		if ValidateDEKReencryptionCommand(invalid) == nil {
			t.Fatalf("accepted invalid command %#v", invalid)
		}
	}
	if _, err := NewDEKReencryptionService(nil, &dekReencryptionExecutorStub{}); !errors.Is(err, ErrDEKReencryption) {
		t.Fatalf("nil loader error = %v", err)
	}
	if _, err := NewDEKReencryptionService(&dekReencryptionLoaderStub{}, nil); !errors.Is(err, ErrDEKReencryption) {
		t.Fatalf("nil executor error = %v", err)
	}
}

type dekReencryptionLoaderStub struct {
	result DEKReencryptionScopeLoad
	err    error
	calls  int
}

func (stub *dekReencryptionLoaderStub) LoadDEKReencryptionScope(
	context.Context,
	DEKReencryptionCommand,
) (DEKReencryptionScopeLoad, error) {
	stub.calls++
	return stub.result, stub.err
}

type dekReencryptionExecutorStub struct {
	result      encryptedobject.ReencryptionBatchResult
	err         error
	calls       int
	keyring     cryptocontent.VaultDEKKeyring
	limit       int
	performedAt int64
}

func (stub *dekReencryptionExecutorStub) RunBatch(
	_ context.Context,
	keyring cryptocontent.VaultDEKKeyring,
	limit int,
	performedAt int64,
) (encryptedobject.ReencryptionBatchResult, error) {
	stub.calls++
	stub.keyring = keyring
	stub.limit = limit
	stub.performedAt = performedAt
	return stub.result, stub.err
}

func testDEKReencryptionCommand(t *testing.T) DEKReencryptionCommand {
	t.Helper()
	accountID, _ := identity.ParseAccountID("01991f20-61d2-7000-8000-000000000101")
	vaultID, _ := identity.ParseVaultID("01991f20-61d2-7000-8000-000000000201")
	target, _ := cryptocontent.ParseDEKVersion(2)
	return DEKReencryptionCommand{
		AccountID: accountID, VaultID: vaultID, TargetVersion: target,
		Limit: 2, PerformedAtMilli: 3_000,
	}
}

func testDEKReencryptionKeyring(
	t *testing.T,
	vaultID identity.VaultID,
	writeVersion cryptocontent.DEKVersion,
) cryptocontent.VaultDEKKeyring {
	t.Helper()
	versions := []cryptocontent.VaultDEKMetadata{
		{
			VaultID: vaultID, DEKVersion: 1,
			KEKReference: "projects/fukamu-test/locations/asia-northeast1/keyRings/notes/cryptoKeys/vault/cryptoKeyVersions/7",
			WrappedDEK:   "d3JhcHBlZC0x", CreatedAtMilli: 1_000,
		},
	}
	if writeVersion == 2 {
		versions = append(versions, cryptocontent.VaultDEKMetadata{
			VaultID: vaultID, DEKVersion: 2,
			KEKReference: "projects/fukamu-test/locations/asia-northeast1/keyRings/notes/cryptoKeys/vault/cryptoKeyVersions/8",
			WrappedDEK:   "d3JhcHBlZC0y", CreatedAtMilli: 2_000,
		})
	}
	keyring, err := cryptocontent.NewVaultDEKKeyring(vaultID, writeVersion, versions)
	if err != nil {
		t.Fatal(err)
	}
	return keyring
}

func testDEKReencryptionJob(command DEKReencryptionCommand) encryptedobject.ReencryptionJob {
	return encryptedobject.ReencryptionJob{
		TargetVersion: command.TargetVersion, State: encryptedobject.ReencryptionRunning,
		Revision: 1, CreatedAtMilli: command.PerformedAtMilli, UpdatedAtMilli: command.PerformedAtMilli,
	}
}
