package localfixture

import (
	"context"
	"errors"
	"io"
	"os"
	"regexp"
	"sort"
	"strings"
	"syscall"

	"github.com/fukamu/notes/backend/internal/accountdeletion"
	recoverykeyadapter "github.com/fukamu/notes/backend/internal/adapters/recoverykey"
	"github.com/fukamu/notes/backend/internal/cryptocontent"
	fixture "github.com/fukamu/notes/backend/internal/localfixture"
)

var nonceReservationName = regexp.MustCompile(`^nonce_v1_[0-9a-f]{64}$`)

const (
	fixtureKeyName              = "dek-1.json"
	fixtureKeyQuarantineName    = ".delete-dek-1.json"
	nonceDeleteQuarantinePrefix = ".delete-"
)

// DeletionBarrier complements the database finalization gates with evidence
// from the exact dedicated fixture directories. It never accepts a path other
// than a validated Layout and never removes an unrecognized entry.
type DeletionBarrier struct {
	scope      accountdeletion.Scope
	layout     Layout
	identities deletionDirectoryIdentities
	roots      *deletionRoots
	delegate   interface {
		accountdeletion.AccountFinalizationGate
		accountdeletion.LegalEvidenceFinalizationGate
		accountdeletion.WrappedKeyFinalizationGate
		accountdeletion.LiveStateFinalizationGate
		FixtureWrappedKeyMetadata(context.Context, accountdeletion.Scope) (*cryptocontent.VaultDEKMetadata, error)
	}
}

type fileIdentity struct {
	device uint64
	inode  uint64
}

type deletionDirectoryIdentities struct {
	root    fileIdentity
	objects fileIdentity
	nonces  fileIdentity
	keys    fileIdentity
}

func NewDeletionBarrier(
	scope accountdeletion.Scope,
	layout Layout,
	delegate interface {
		accountdeletion.AccountFinalizationGate
		accountdeletion.LegalEvidenceFinalizationGate
		accountdeletion.WrappedKeyFinalizationGate
		accountdeletion.LiveStateFinalizationGate
		FixtureWrappedKeyMetadata(context.Context, accountdeletion.Scope) (*cryptocontent.VaultDEKMetadata, error)
	},
) (*DeletionBarrier, error) {
	opened, err := OpenLayout(layout.RootDirectory)
	if !accountdeletion.ValidScope(scope) || delegate == nil || err != nil || opened != layout {
		return nil, ErrLayoutOperation
	}
	identities, err := captureDeletionDirectoryIdentities(layout)
	if err != nil {
		return nil, ErrLayoutOperation
	}
	barrier := &DeletionBarrier{
		scope: scope, layout: layout, identities: identities, delegate: delegate,
	}
	roots, err := barrier.openDeletionRoots(context.Background())
	if err != nil {
		return nil, ErrLayoutOperation
	}
	barrier.roots = roots
	return barrier, nil
}

func (barrier *DeletionBarrier) Evaluate(
	ctx context.Context,
	command accountdeletion.AccountFinalizationCommand,
) (accountdeletion.AccountFinalizationResult, error) {
	if !barrier.valid(command) {
		return accountdeletion.AccountFinalizationResult{}, ErrLayoutOperation
	}
	roots, err := barrier.heldDeletionRoots(ctx)
	if err != nil {
		return accountdeletion.AccountFinalizationResult{}, err
	}
	result, err := barrier.delegate.Evaluate(ctx, command)
	if err != nil || result.Kind != accountdeletion.AccountFinalizationConfirmed {
		return result, err
	}
	empty, err := exactRootEmpty(ctx, roots.objects)
	if err != nil {
		return accountdeletion.AccountFinalizationResult{}, err
	}
	if !empty {
		return accountdeletion.AccountFinalizationResult{
			Kind:   accountdeletion.AccountFinalizationRetryableFailure,
			Reason: accountdeletion.AccountFinalizationPrivateObjectsRemaining,
		}, nil
	}
	return result, nil
}

func (barrier *DeletionBarrier) EvaluateLegalEvidence(
	ctx context.Context,
	command accountdeletion.AccountFinalizationCommand,
	policy accountdeletion.LegalEvidenceFinalizationPolicy,
) (accountdeletion.AccountFinalizationResult, error) {
	if !barrier.valid(command) {
		return accountdeletion.AccountFinalizationResult{}, ErrLayoutOperation
	}
	_, err := barrier.heldDeletionRoots(ctx)
	if err != nil {
		return accountdeletion.AccountFinalizationResult{}, err
	}
	return barrier.delegate.EvaluateLegalEvidence(ctx, command, policy)
}

func (barrier *DeletionBarrier) FinalizeWrappedKeys(
	ctx context.Context,
	command accountdeletion.AccountFinalizationCommand,
	policy accountdeletion.LegalEvidenceFinalizationPolicy,
) (accountdeletion.AccountFinalizationResult, error) {
	if !barrier.valid(command) {
		return accountdeletion.AccountFinalizationResult{}, ErrLayoutOperation
	}
	roots, err := barrier.heldDeletionRoots(ctx)
	if err != nil {
		return accountdeletion.AccountFinalizationResult{}, err
	}
	objectsEmpty, err := exactRootEmpty(ctx, roots.objects)
	if err != nil {
		return accountdeletion.AccountFinalizationResult{}, err
	}
	if !objectsEmpty {
		return accountdeletion.AccountFinalizationResult{
			Kind:   accountdeletion.AccountFinalizationRetryableFailure,
			Reason: accountdeletion.AccountFinalizationPrivateObjectsRemaining,
		}, nil
	}
	databaseKey, err := barrier.delegate.FixtureWrappedKeyMetadata(ctx, barrier.scope)
	if err != nil {
		return accountdeletion.AccountFinalizationResult{}, err
	}
	keyFile, err := validateFixtureKeyInventory(
		ctx, roots.keys, barrier.scope, databaseKey, databaseKey == nil,
	)
	if err != nil {
		return wrappedKeyInventoryResult(err)
	}
	nonceFiles, err := validateNonceInventory(ctx, roots.nonces)
	if err != nil {
		return wrappedKeyInventoryResult(err)
	}
	// A DB key without its raw fixture key is an impossible pre-effect state.
	// The inverse is the recoverable DB-commit-before-file-delete crash window.
	if databaseKey != nil && keyFile == nil {
		return accountdeletion.AccountFinalizationResult{
			Kind:   accountdeletion.AccountFinalizationRetryableFailure,
			Reason: accountdeletion.AccountFinalizationWrappedKeysRemaining,
		}, nil
	}
	result, err := barrier.delegate.FinalizeWrappedKeys(ctx, command, policy)
	if err != nil || result.Kind != accountdeletion.AccountFinalizationConfirmed {
		return result, err
	}
	if empty, emptyErr := exactRootEmpty(ctx, roots.objects); emptyErr != nil || !empty {
		if emptyErr != nil {
			return accountdeletion.AccountFinalizationResult{}, emptyErr
		}
		return accountdeletion.AccountFinalizationResult{
			Kind:   accountdeletion.AccountFinalizationRetryableFailure,
			Reason: accountdeletion.AccountFinalizationPrivateObjectsRemaining,
		}, nil
	}
	if err := destroyFixtureKey(
		ctx, roots.keys, barrier.scope, databaseKey, keyFile,
	); err != nil {
		if errors.Is(err, errRecognizedFilesRemain) {
			return accountdeletion.AccountFinalizationResult{
				Kind:   accountdeletion.AccountFinalizationRetryableFailure,
				Reason: accountdeletion.AccountFinalizationWrappedKeysRemaining,
			}, nil
		}
		return accountdeletion.AccountFinalizationResult{}, err
	}
	if err := destroyNonceReservations(ctx, roots.nonces, nonceFiles); err != nil {
		if errors.Is(err, errRecognizedFilesRemain) {
			return accountdeletion.AccountFinalizationResult{
				Kind:   accountdeletion.AccountFinalizationRetryableFailure,
				Reason: accountdeletion.AccountFinalizationWrappedKeysRemaining,
			}, nil
		}
		return accountdeletion.AccountFinalizationResult{}, err
	}
	return result, nil
}

func (barrier *DeletionBarrier) FinalizeLiveState(
	ctx context.Context,
	command accountdeletion.AccountFinalizationCommand,
	policy accountdeletion.LegalEvidenceFinalizationPolicy,
) (accountdeletion.AccountFinalizationResult, error) {
	if !barrier.valid(command) {
		return accountdeletion.AccountFinalizationResult{}, ErrLayoutOperation
	}
	roots, err := barrier.heldDeletionRoots(ctx)
	if err != nil {
		return accountdeletion.AccountFinalizationResult{}, err
	}
	for _, root := range []*os.Root{
		roots.objects,
		roots.nonces,
		roots.keys,
	} {
		empty, err := exactRootEmpty(ctx, root)
		if err != nil {
			return accountdeletion.AccountFinalizationResult{}, err
		}
		if !empty {
			return accountdeletion.AccountFinalizationResult{
				Kind:   accountdeletion.AccountFinalizationRetryableFailure,
				Reason: accountdeletion.AccountFinalizationLiveStateRemaining,
			}, nil
		}
	}
	return barrier.delegate.FinalizeLiveState(ctx, command, policy)
}

func (barrier *DeletionBarrier) valid(command accountdeletion.AccountFinalizationCommand) bool {
	if barrier == nil || barrier.delegate == nil || command.Scope != barrier.scope ||
		!accountdeletion.ValidAccountFinalizationCommand(command) {
		return false
	}
	return true
}

// Close releases the directory handles which pin the exact disposable fixture
// roots for the composition lifetime. Runtime shutdown waits for handlers
// before invoking Close, so no destructive operation can race this release.
func (barrier *DeletionBarrier) Close() error {
	if barrier == nil {
		return ErrLayoutOperation
	}
	if barrier.roots == nil {
		return nil
	}
	barrier.roots.close()
	barrier.roots = nil
	return nil
}

var errRecognizedFilesRemain = errors.New("unrecognized fixture deletion inventory")

type anchoredFile struct {
	name     string
	identity fileIdentity
}

type deletionRoots struct {
	parent  *os.Root
	objects *os.Root
	nonces  *os.Root
	keys    *os.Root
}

func (roots *deletionRoots) close() {
	if roots == nil {
		return
	}
	for _, root := range []*os.Root{roots.keys, roots.nonces, roots.objects, roots.parent} {
		if root != nil {
			_ = root.Close()
		}
	}
}

func captureDeletionDirectoryIdentities(layout Layout) (deletionDirectoryIdentities, error) {
	var identities deletionDirectoryIdentities
	for _, target := range []struct {
		path string
		set  *fileIdentity
	}{
		{layout.RootDirectory, &identities.root},
		{layout.ObjectDirectory, &identities.objects},
		{layout.NonceDirectory, &identities.nonces},
		{layout.KeyDirectory, &identities.keys},
	} {
		info, err := os.Lstat(target.path)
		identity, identityErr := identityForPrivateDirectory(info)
		if err != nil || identityErr != nil {
			return deletionDirectoryIdentities{}, ErrLayoutOperation
		}
		*target.set = identity
	}
	return identities, nil
}

func (barrier *DeletionBarrier) openDeletionRoots(ctx context.Context) (*deletionRoots, error) {
	if barrier == nil || ctx == nil {
		return nil, ErrLayoutOperation
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if !pathHasDirectoryIdentity(barrier.layout.RootDirectory, barrier.identities.root) {
		return nil, ErrLayoutOperation
	}
	parent, err := os.OpenRoot(barrier.layout.RootDirectory)
	if err != nil || !rootHasDirectoryIdentity(parent, barrier.identities.root) {
		if parent != nil {
			_ = parent.Close()
		}
		return nil, ErrLayoutOperation
	}
	// os.OpenRoot follows the final path component. Re-check the path after the
	// handle is open so a rename-to-symlink race cannot bind this barrier through
	// a replacement root name, even when that symlink points at the old inode.
	if !pathHasDirectoryIdentity(barrier.layout.RootDirectory, barrier.identities.root) {
		_ = parent.Close()
		return nil, ErrLayoutOperation
	}
	roots := &deletionRoots{parent: parent}
	openChild := func(name string, expected fileIdentity) (*os.Root, error) {
		info, statErr := parent.Lstat(name)
		identity, identityErr := identityForPrivateDirectory(info)
		if statErr != nil || identityErr != nil || identity != expected {
			return nil, ErrLayoutOperation
		}
		child, openErr := parent.OpenRoot(name)
		if openErr != nil || !rootHasDirectoryIdentity(child, expected) {
			if child != nil {
				_ = child.Close()
			}
			return nil, ErrLayoutOperation
		}
		// Detect a child-name swap between Lstat and OpenRoot.
		info, statErr = parent.Lstat(name)
		identity, identityErr = identityForPrivateDirectory(info)
		if statErr != nil || identityErr != nil || identity != expected {
			_ = child.Close()
			return nil, ErrLayoutOperation
		}
		return child, nil
	}
	if roots.objects, err = openChild(fixture.ObjectDirectoryName, barrier.identities.objects); err != nil {
		roots.close()
		return nil, err
	}
	if roots.nonces, err = openChild(fixture.NonceDirectoryName, barrier.identities.nonces); err != nil {
		roots.close()
		return nil, err
	}
	if roots.keys, err = openChild(fixture.KeyDirectoryName, barrier.identities.keys); err != nil {
		roots.close()
		return nil, err
	}
	entries, err := readRootEntries(parent)
	if err != nil || !exactDeletionRootEntries(entries) {
		roots.close()
		return nil, ErrLayoutOperation
	}
	return roots, nil
}

func (barrier *DeletionBarrier) heldDeletionRoots(ctx context.Context) (*deletionRoots, error) {
	if barrier == nil || ctx == nil || barrier.roots == nil {
		return nil, ErrLayoutOperation
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	roots := barrier.roots
	if !pathHasDirectoryIdentity(barrier.layout.RootDirectory, barrier.identities.root) ||
		!rootHasDirectoryIdentity(roots.parent, barrier.identities.root) ||
		!rootHasDirectoryIdentity(roots.objects, barrier.identities.objects) ||
		!rootHasDirectoryIdentity(roots.nonces, barrier.identities.nonces) ||
		!rootHasDirectoryIdentity(roots.keys, barrier.identities.keys) {
		return nil, ErrLayoutOperation
	}
	for _, child := range []struct {
		name     string
		expected fileIdentity
	}{
		{fixture.ObjectDirectoryName, barrier.identities.objects},
		{fixture.NonceDirectoryName, barrier.identities.nonces},
		{fixture.KeyDirectoryName, barrier.identities.keys},
	} {
		info, err := roots.parent.Lstat(child.name)
		identity, identityErr := identityForPrivateDirectory(info)
		if err != nil || identityErr != nil || identity != child.expected {
			return nil, ErrLayoutOperation
		}
	}
	entries, err := readRootEntries(roots.parent)
	if err != nil || !exactDeletionRootEntries(entries) {
		return nil, ErrLayoutOperation
	}
	return roots, nil
}

func exactDeletionRootEntries(entries []os.DirEntry) bool {
	if len(entries) != 3 {
		return false
	}
	names := make([]string, 0, len(entries))
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	sort.Strings(names)
	want := []string{fixture.KeyDirectoryName, fixture.NonceDirectoryName, fixture.ObjectDirectoryName}
	sort.Strings(want)
	for index := range want {
		if names[index] != want[index] {
			return false
		}
	}
	return true
}

func exactRootEmpty(ctx context.Context, root *os.Root) (bool, error) {
	if ctx == nil {
		return false, ErrLayoutOperation
	}
	if err := ctx.Err(); err != nil {
		return false, err
	}
	entries, err := readRootEntries(root)
	if err != nil {
		return false, err
	}
	return len(entries) == 0, nil
}

func privateRegularEntry(entry os.DirEntry) bool {
	if entry.Type()&os.ModeSymlink != 0 {
		return false
	}
	info, err := entry.Info()
	return err == nil && privateRegularInfo(info)
}

func privateRegularInfo(info os.FileInfo) bool {
	if info == nil || !info.Mode().IsRegular() || info.Mode().Perm() != 0o600 {
		return false
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	return ok && stat.Uid == uint32(os.Getuid()) && stat.Nlink == 1
}

func validateFixtureKeyInventory(
	ctx context.Context,
	root *os.Root,
	scope accountdeletion.Scope,
	expected *cryptocontent.VaultDEKMetadata,
	allowQuarantine bool,
) (*anchoredFile, error) {
	if ctx == nil {
		return nil, ErrLayoutOperation
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	entries, err := readRootEntries(root)
	if err != nil || len(entries) > 1 {
		return nil, errRecognizedFilesRemain
	}
	if len(entries) == 0 {
		return nil, nil
	}
	name := entries[0].Name()
	if name != fixtureKeyName && (!allowQuarantine || name != fixtureKeyQuarantineName) {
		return nil, errRecognizedFilesRemain
	}
	info, statErr := root.Lstat(name)
	identity, identityErr := identityForPrivateFile(info)
	if statErr != nil || identityErr != nil || info.Size() < 1 || info.Size() > 32*1024 {
		return nil, errRecognizedFilesRemain
	}
	file, err := root.Open(name)
	if err != nil {
		return nil, errRecognizedFilesRemain
	}
	defer file.Close()
	openedInfo, err := file.Stat()
	openedIdentity, openedIdentityErr := identityForPrivateFile(openedInfo)
	if err != nil || openedIdentityErr != nil || openedIdentity != identity {
		return nil, errRecognizedFilesRemain
	}
	encoded, err := io.ReadAll(io.LimitReader(file, 32*1024+1))
	if err != nil || len(encoded) < 1 || len(encoded) > 32*1024 ||
		recoverykeyadapter.ValidateFixtureKeyFile(encoded, scope.VaultID, expected) != nil {
		clear(encoded)
		return nil, errRecognizedFilesRemain
	}
	clear(encoded)
	return &anchoredFile{name: name, identity: identity}, nil
}

func validateNonceInventory(ctx context.Context, root *os.Root) ([]anchoredFile, error) {
	if ctx == nil {
		return nil, ErrLayoutOperation
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	entries, err := readRootEntries(root)
	if err != nil {
		return nil, err
	}
	files := make([]anchoredFile, 0, len(entries))
	logicalNames := make(map[string]struct{}, len(entries))
	for _, entry := range entries {
		name := entry.Name()
		logicalName := name
		if strings.HasPrefix(logicalName, nonceDeleteQuarantinePrefix) {
			logicalName = strings.TrimPrefix(logicalName, nonceDeleteQuarantinePrefix)
		}
		if _, duplicate := logicalNames[logicalName]; duplicate {
			return nil, errRecognizedFilesRemain
		}
		info, statErr := root.Lstat(name)
		identity, identityErr := identityForPrivateFile(info)
		if statErr != nil || identityErr != nil || info.Size() != 0 || !nonceReservationName.MatchString(logicalName) {
			return nil, errRecognizedFilesRemain
		}
		logicalNames[logicalName] = struct{}{}
		files = append(files, anchoredFile{name: name, identity: identity})
	}
	sort.Slice(files, func(left, right int) bool { return files[left].name < files[right].name })
	return files, nil
}

func destroyFixtureKey(
	ctx context.Context,
	root *os.Root,
	scope accountdeletion.Scope,
	metadata *cryptocontent.VaultDEKMetadata,
	expected *anchoredFile,
) error {
	current, err := validateFixtureKeyInventory(ctx, root, scope, metadata, true)
	if err != nil {
		return err
	}
	if expected == nil {
		if current != nil {
			return errRecognizedFilesRemain
		}
		return syncOpenedRoot(root)
	}
	if current == nil || current.name != expected.name || current.identity != expected.identity {
		return errRecognizedFilesRemain
	}
	if current.name == fixtureKeyName {
		if _, err := root.Lstat(fixtureKeyQuarantineName); !errors.Is(err, os.ErrNotExist) {
			return errRecognizedFilesRemain
		}
		if err := root.Rename(fixtureKeyName, fixtureKeyQuarantineName); err != nil {
			return ErrLayoutOperation
		}
		current.name = fixtureKeyQuarantineName
	}
	quarantined, err := validateFixtureKeyInventory(ctx, root, scope, metadata, true)
	if err != nil || quarantined == nil || quarantined.name != fixtureKeyQuarantineName ||
		quarantined.identity != expected.identity {
		return errRecognizedFilesRemain
	}
	if root.Remove(fixtureKeyQuarantineName) != nil {
		return ErrLayoutOperation
	}
	return syncOpenedRoot(root)
}

func destroyNonceReservations(ctx context.Context, root *os.Root, expected []anchoredFile) error {
	current, err := validateNonceInventory(ctx, root)
	if err != nil {
		return err
	}
	if !sameAnchoredFiles(current, expected) {
		return errRecognizedFilesRemain
	}
	for _, file := range current {
		if err := ctx.Err(); err != nil {
			return err
		}
		quarantine := file.name
		if !strings.HasPrefix(file.name, nonceDeleteQuarantinePrefix) {
			quarantine = nonceDeleteQuarantinePrefix + file.name
			if _, err := root.Lstat(quarantine); !errors.Is(err, os.ErrNotExist) {
				return errRecognizedFilesRemain
			}
			if err := root.Rename(file.name, quarantine); err != nil {
				return ErrLayoutOperation
			}
		}
		info, statErr := root.Lstat(quarantine)
		identity, identityErr := identityForPrivateFile(info)
		if statErr != nil || identityErr != nil || identity != file.identity || info.Size() != 0 {
			return errRecognizedFilesRemain
		}
		if root.Remove(quarantine) != nil {
			return ErrLayoutOperation
		}
	}
	return syncOpenedRoot(root)
}

func sameAnchoredFiles(left, right []anchoredFile) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}

func identityForPrivateFile(info os.FileInfo) (fileIdentity, error) {
	if !privateRegularInfo(info) {
		return fileIdentity{}, ErrLayoutOperation
	}
	return identityFromInfo(info)
}

func identityForPrivateDirectory(info os.FileInfo) (fileIdentity, error) {
	if info == nil || !info.IsDir() || info.Mode().Perm() != 0o700 ||
		info.Mode()&(os.ModeSetuid|os.ModeSetgid|os.ModeSticky) != 0 {
		return fileIdentity{}, ErrLayoutOperation
	}
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok || stat.Uid != uint32(os.Getuid()) {
		return fileIdentity{}, ErrLayoutOperation
	}
	return fileIdentity{device: uint64(stat.Dev), inode: stat.Ino}, nil
}

func identityFromInfo(info os.FileInfo) (fileIdentity, error) {
	stat, ok := info.Sys().(*syscall.Stat_t)
	if !ok {
		return fileIdentity{}, ErrLayoutOperation
	}
	return fileIdentity{device: uint64(stat.Dev), inode: stat.Ino}, nil
}

func rootHasDirectoryIdentity(root *os.Root, expected fileIdentity) bool {
	if root == nil {
		return false
	}
	info, err := root.Stat(".")
	identity, identityErr := identityForPrivateDirectory(info)
	return err == nil && identityErr == nil && identity == expected
}

func pathHasDirectoryIdentity(path string, expected fileIdentity) bool {
	info, err := os.Lstat(path)
	identity, identityErr := identityForPrivateDirectory(info)
	return err == nil && identityErr == nil && identity == expected
}

func readRootEntries(root *os.Root) ([]os.DirEntry, error) {
	directory, err := root.Open(".")
	if err != nil {
		return nil, ErrLayoutOperation
	}
	defer directory.Close()
	entries, err := directory.ReadDir(-1)
	if err != nil {
		return nil, ErrLayoutOperation
	}
	return entries, nil
}

func syncOpenedRoot(root *os.Root) error {
	directory, err := root.Open(".")
	if err != nil {
		return ErrLayoutOperation
	}
	defer directory.Close()
	if err := directory.Sync(); err != nil {
		return ErrLayoutOperation
	}
	return nil
}

func wrappedKeyInventoryResult(err error) (accountdeletion.AccountFinalizationResult, error) {
	if errors.Is(err, errRecognizedFilesRemain) {
		return accountdeletion.AccountFinalizationResult{
			Kind:   accountdeletion.AccountFinalizationRetryableFailure,
			Reason: accountdeletion.AccountFinalizationWrappedKeysRemaining,
		}, nil
	}
	return accountdeletion.AccountFinalizationResult{}, err
}
