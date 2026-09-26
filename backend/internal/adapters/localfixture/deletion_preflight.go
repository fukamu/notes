package localfixture

import (
	"context"
	"os"
	"strings"

	"github.com/fukamu/notes/backend/internal/accountdeletion"
	"github.com/fukamu/notes/backend/internal/cryptocontent"
	"github.com/fukamu/notes/backend/internal/encryptedobject"
	"github.com/fukamu/notes/backend/internal/identity"
)

type DeletionKeyInventory struct {
	DatabaseMetadata      *cryptocontent.VaultDEKMetadata
	AllowResidualFile     bool
	ForbidFile            bool
	ForbidObjectFiles     bool
	ForbidNonceFiles      bool
	AllowObjectQuarantine bool
	AllowNonceQuarantine  bool
}

// CheckDeletionInventory correlates actual files with the guarded database
// inventory before any deletion effect can be composed. Missing object files
// are allowed because a crash may occur after storage deletion and before
// outbox confirmation; an untracked object or temporary file is never allowed.
func CheckDeletionInventory(
	ctx context.Context,
	layout Layout,
	vaultID identity.VaultID,
	keyInventory DeletionKeyInventory,
	objectKeys []encryptedobject.ObjectKey,
) error {
	if ctx == nil {
		return ErrLayoutOperation
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	opened, err := OpenLayout(layout.RootDirectory)
	if err != nil || opened != layout {
		return ErrLayoutOperation
	}
	expected := make(map[string]struct{}, len(objectKeys))
	for _, objectKey := range objectKeys {
		if _, err := encryptedobject.ParseObjectKey(string(objectKey)); err != nil {
			return ErrLayoutOperation
		}
		expected[string(objectKey)] = struct{}{}
	}
	objectEntries, err := os.ReadDir(layout.ObjectDirectory)
	if err != nil || (keyInventory.ForbidObjectFiles && len(objectEntries) != 0) {
		return ErrLayoutOperation
	}
	seenObjects := make(map[string]struct{}, len(objectEntries))
	for _, entry := range objectEntries {
		logicalName := entry.Name()
		if strings.HasPrefix(logicalName, objectDeleteQuarantinePrefix) {
			if !keyInventory.AllowObjectQuarantine {
				return ErrLayoutOperation
			}
			logicalName = strings.TrimPrefix(logicalName, objectDeleteQuarantinePrefix)
		}
		if _, duplicate := seenObjects[logicalName]; duplicate {
			return ErrLayoutOperation
		}
		if _, ok := expected[logicalName]; !ok || !privateRegularEntry(entry) {
			return ErrLayoutOperation
		}
		seenObjects[logicalName] = struct{}{}
	}
	keyEntries, err := os.ReadDir(layout.KeyDirectory)
	if err != nil || len(keyEntries) > 1 || (keyInventory.ForbidFile && len(keyEntries) != 0) ||
		(keyInventory.DatabaseMetadata != nil && len(keyEntries) != 1) {
		return ErrLayoutOperation
	}
	if len(keyEntries) == 1 {
		name := keyEntries[0].Name()
		allowQuarantine := keyInventory.DatabaseMetadata == nil && keyInventory.AllowResidualFile
		if keyInventory.ForbidFile ||
			(keyInventory.DatabaseMetadata == nil && !keyInventory.AllowResidualFile) ||
			(name != fixtureKeyName && (!allowQuarantine || name != fixtureKeyQuarantineName)) ||
			!privateRegularEntry(keyEntries[0]) {
			return ErrLayoutOperation
		}
		keyRoot, err := os.OpenRoot(layout.KeyDirectory)
		if err != nil {
			return ErrLayoutOperation
		}
		validated, validateErr := validateFixtureKeyInventory(
			ctx, keyRoot, accountdeletion.Scope{VaultID: vaultID},
			keyInventory.DatabaseMetadata, allowQuarantine,
		)
		closeErr := keyRoot.Close()
		if validateErr != nil || closeErr != nil || validated == nil || validated.name != name {
			return ErrLayoutOperation
		}
	}
	nonceEntries, err := os.ReadDir(layout.NonceDirectory)
	if err != nil || (keyInventory.ForbidNonceFiles && len(nonceEntries) != 0) {
		return ErrLayoutOperation
	}
	seenNonces := make(map[string]struct{}, len(nonceEntries))
	for _, entry := range nonceEntries {
		logicalName := entry.Name()
		if strings.HasPrefix(logicalName, nonceDeleteQuarantinePrefix) {
			if !keyInventory.AllowNonceQuarantine {
				return ErrLayoutOperation
			}
			logicalName = strings.TrimPrefix(logicalName, nonceDeleteQuarantinePrefix)
		}
		if _, duplicate := seenNonces[logicalName]; duplicate {
			return ErrLayoutOperation
		}
		info, infoErr := entry.Info()
		if infoErr != nil || info.Size() != 0 || !nonceReservationName.MatchString(logicalName) ||
			!privateRegularEntry(entry) {
			return ErrLayoutOperation
		}
		seenNonces[logicalName] = struct{}{}
	}
	return nil
}
