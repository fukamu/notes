package cryptocontent

import (
	"context"

	"github.com/fukamu/notes/backend/internal/identity"
)

type KeyManagementPort interface {
	GenerateDataKey(context.Context, identity.VaultID, DEKVersion) (VaultDEKMetadata, *DataEncryptionKey, error)
	UnwrapDataKey(context.Context, VaultDEKMetadata) (*DataEncryptionKey, error)
}

type NonceGeneratorPort interface {
	CreateNonce(context.Context) ([]byte, error)
}

type NonceReservationPort interface {
	ReserveNonce(context.Context, identity.VaultID, DEKVersion, string) (bool, error)
}

type AES256GCMPort interface {
	Seal(*DataEncryptionKey, string, string, []byte) (string, error)
	Open(*DataEncryptionKey, string, string, string) ([]byte, error)
}
