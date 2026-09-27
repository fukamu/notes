package encryptedobject

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"

	"github.com/fukamu/notes/backend/internal/cryptocontent"
	"github.com/fukamu/notes/backend/internal/identity"
)

type recoveryManifestWire struct {
	Format       string                 `json:"format"`
	BackupID     string                 `json:"backupId"`
	AccountID    string                 `json:"accountId"`
	VaultID      string                 `json:"vaultId"`
	CapturedAt   int64                  `json:"capturedAt"`
	DeleteAfter  int64                  `json:"deleteAfter"`
	Keyring      recoveryKeyringWire    `json:"keyring"`
	Rotation     recoveryRotationWire   `json:"rotation"`
	Reencryption json.RawMessage        `json:"reencryption"`
	Objects      []recoveryMetadataWire `json:"objects"`
}

type recoveryKeyringWire struct {
	VaultID      string                           `json:"vaultId"`
	WriteVersion int64                            `json:"writeVersion"`
	Versions     []cryptocontent.VaultDEKMetadata `json:"versions"`
}

type recoveryRotationWire struct {
	OperationID   string          `json:"operationId"`
	AccountID     string          `json:"accountId"`
	VaultID       string          `json:"vaultId"`
	Revision      int64           `json:"revision"`
	SourceVersion int64           `json:"sourceVersion"`
	TargetVersion int64           `json:"targetVersion"`
	State         json.RawMessage `json:"state"`
	CreatedAt     int64           `json:"createdAt"`
	UpdatedAt     int64           `json:"updatedAt"`
}

type recoveryObjectWire struct {
	Kind     string `json:"kind"`
	ObjectID string `json:"objectId"`
}

type recoveryMetadataWire struct {
	Object          recoveryObjectWire `json:"object"`
	ObjectRevision  int64              `json:"objectRevision"`
	WriteID         string             `json:"writeId"`
	ObjectKey       string             `json:"objectKey"`
	PlaintextBytes  int64              `json:"plaintextBytes"`
	CiphertextBytes int64              `json:"ciphertextBytes"`
	CryptoVersion   string             `json:"cryptoVersion"`
	DEKVersion      int64              `json:"dekVersion"`
	CreatedAt       int64              `json:"createdAt"`
}

type recoveryPositionWire struct {
	Object         recoveryObjectWire `json:"object"`
	ObjectRevision int64              `json:"objectRevision"`
}

func DecodeRecoveryManifest(source []byte) (RecoveryManifest, error) {
	var wire recoveryManifestWire
	if len(source) == 0 || strictRecoveryJSON(source, &wire) != nil {
		return RecoveryManifest{}, ErrInvalidRecovery
	}
	accountID, accountErr := identity.ParseAccountID(wire.AccountID)
	vaultID, vaultErr := identity.ParseVaultID(wire.VaultID)
	backupID, backupErr := ParseRecoveryBackupID(wire.BackupID)
	keyring, keyringErr := decodeRecoveryKeyring(wire.Keyring)
	rotation, rotationErr := decodeRecoveryRotation(wire.Rotation)
	reencryption, reencryptionErr := decodeRecoveryReencryption(wire.Reencryption)
	objects := make([]Metadata, len(wire.Objects))
	objectsErr := error(nil)
	for index, rawMetadata := range wire.Objects {
		metadata, err := decodeRecoveryMetadata(rawMetadata)
		if err != nil {
			objectsErr = err
			break
		}
		objects[index] = metadata
	}
	if accountErr != nil || vaultErr != nil || backupErr != nil || keyringErr != nil ||
		rotationErr != nil || reencryptionErr != nil || objectsErr != nil {
		return RecoveryManifest{}, ErrInvalidRecovery
	}
	manifest := RecoveryManifest{
		Format:        VaultRecoveryFormatValue(wire.Format),
		RecoveryScope: RecoveryScope{AccountID: accountID, VaultID: vaultID},
		BackupID:      backupID, CapturedAt: wire.CapturedAt, DeleteAfter: wire.DeleteAfter,
		Keyring: keyring, Rotation: rotation, Reencryption: reencryption, Objects: objects,
	}
	if ValidateRecoveryManifest(manifest) != nil {
		return RecoveryManifest{}, ErrInvalidRecovery
	}
	return manifest, nil
}

func EncodeRecoveryManifest(manifest RecoveryManifest) ([]byte, error) {
	if ValidateRecoveryManifest(manifest) != nil {
		return nil, ErrInvalidRecovery
	}
	reencryption, err := encodeRecoveryReencryption(manifest.Reencryption)
	if err != nil {
		return nil, ErrInvalidRecovery
	}
	rotation, err := encodeRecoveryRotation(manifest.Rotation)
	if err != nil {
		return nil, ErrInvalidRecovery
	}
	objects := make([]recoveryMetadataWire, len(manifest.Objects))
	for index, metadata := range manifest.Objects {
		objects[index] = encodeRecoveryMetadata(metadata)
	}
	wire := recoveryManifestWire{
		Format: string(manifest.Format), BackupID: string(manifest.BackupID),
		AccountID: string(manifest.AccountID), VaultID: string(manifest.VaultID),
		CapturedAt: manifest.CapturedAt, DeleteAfter: manifest.DeleteAfter,
		Keyring: recoveryKeyringWire{
			VaultID: string(manifest.Keyring.VaultID), WriteVersion: int64(manifest.Keyring.WriteVersion),
			Versions: append([]cryptocontent.VaultDEKMetadata(nil), manifest.Keyring.Versions...),
		},
		Rotation: rotation, Reencryption: reencryption, Objects: objects,
	}
	encoded, err := json.Marshal(wire)
	if err != nil {
		return nil, ErrInvalidRecovery
	}
	return encoded, nil
}

func decodeRecoveryKeyring(wire recoveryKeyringWire) (cryptocontent.VaultDEKKeyring, error) {
	vaultID, vaultErr := identity.ParseVaultID(wire.VaultID)
	writeVersion, versionErr := cryptocontent.ParseDEKVersion(wire.WriteVersion)
	if vaultErr != nil || versionErr != nil {
		return cryptocontent.VaultDEKKeyring{}, ErrInvalidRecovery
	}
	keyring, err := cryptocontent.NewVaultDEKKeyring(vaultID, writeVersion, wire.Versions)
	if err != nil {
		return cryptocontent.VaultDEKKeyring{}, ErrInvalidRecovery
	}
	return keyring, nil
}

func decodeRecoveryRotation(wire recoveryRotationWire) (cryptocontent.RotationOperation, error) {
	accountID, accountErr := identity.ParseAccountID(wire.AccountID)
	vaultID, vaultErr := identity.ParseVaultID(wire.VaultID)
	operationID, operationErr := cryptocontent.ParseRotationOperationID(wire.OperationID)
	source, sourceErr := cryptocontent.ParseDEKVersion(wire.SourceVersion)
	target, targetErr := cryptocontent.ParseDEKVersion(wire.TargetVersion)
	if accountErr != nil || vaultErr != nil || operationErr != nil || sourceErr != nil || targetErr != nil {
		return cryptocontent.RotationOperation{}, ErrInvalidRecovery
	}
	var kind struct {
		Kind string `json:"kind"`
	}
	if err := json.Unmarshal(wire.State, &kind); err != nil {
		return cryptocontent.RotationOperation{}, ErrInvalidRecovery
	}
	var state cryptocontent.RotationState
	switch kind.Kind {
	case "generating":
		var raw struct {
			Kind string `json:"kind"`
		}
		if strictRecoveryJSON(wire.State, &raw) != nil || raw.Kind != "generating" {
			return cryptocontent.RotationOperation{}, ErrInvalidRecovery
		}
		state = cryptocontent.RotationGenerating{}
	case "promoting":
		var raw struct {
			Kind     string                         `json:"kind"`
			Metadata cryptocontent.VaultDEKMetadata `json:"metadata"`
		}
		if strictRecoveryJSON(wire.State, &raw) != nil || raw.Kind != "promoting" {
			return cryptocontent.RotationOperation{}, ErrInvalidRecovery
		}
		state = cryptocontent.RotationPromoting{Metadata: raw.Metadata}
	case "completed":
		var raw struct {
			Kind        string                         `json:"kind"`
			Metadata    cryptocontent.VaultDEKMetadata `json:"metadata"`
			CompletedAt int64                          `json:"completedAt"`
		}
		if strictRecoveryJSON(wire.State, &raw) != nil || raw.Kind != "completed" {
			return cryptocontent.RotationOperation{}, ErrInvalidRecovery
		}
		state = cryptocontent.RotationCompleted{Metadata: raw.Metadata, CompletedAtMilli: raw.CompletedAt}
	default:
		return cryptocontent.RotationOperation{}, ErrInvalidRecovery
	}
	operation := cryptocontent.RotationOperation{
		RotationScope: cryptocontent.RotationScope{AccountID: accountID, VaultID: vaultID},
		OperationID:   operationID, Revision: cryptocontent.RotationRevision(wire.Revision),
		SourceVersion: source, TargetVersion: target, State: state,
		CreatedAtMilli: wire.CreatedAt, UpdatedAtMilli: wire.UpdatedAt,
	}
	if cryptocontent.ValidateRotationOperation(operation) != nil {
		return cryptocontent.RotationOperation{}, ErrInvalidRecovery
	}
	return operation, nil
}

func encodeRecoveryRotation(operation cryptocontent.RotationOperation) (recoveryRotationWire, error) {
	var state any
	switch value := operation.State.(type) {
	case cryptocontent.RotationGenerating:
		state = struct {
			Kind string `json:"kind"`
		}{Kind: "generating"}
	case cryptocontent.RotationPromoting:
		state = struct {
			Kind     string                         `json:"kind"`
			Metadata cryptocontent.VaultDEKMetadata `json:"metadata"`
		}{Kind: "promoting", Metadata: value.Metadata}
	case cryptocontent.RotationCompleted:
		state = struct {
			Kind        string                         `json:"kind"`
			Metadata    cryptocontent.VaultDEKMetadata `json:"metadata"`
			CompletedAt int64                          `json:"completedAt"`
		}{Kind: "completed", Metadata: value.Metadata, CompletedAt: value.CompletedAtMilli}
	default:
		return recoveryRotationWire{}, ErrInvalidRecovery
	}
	encodedState, err := json.Marshal(state)
	if err != nil {
		return recoveryRotationWire{}, ErrInvalidRecovery
	}
	return recoveryRotationWire{
		OperationID: string(operation.OperationID), AccountID: string(operation.AccountID),
		VaultID: string(operation.VaultID), Revision: int64(operation.Revision),
		SourceVersion: int64(operation.SourceVersion), TargetVersion: int64(operation.TargetVersion),
		State: encodedState, CreatedAt: operation.CreatedAtMilli, UpdatedAt: operation.UpdatedAtMilli,
	}, nil
}

func decodeRecoveryReencryption(source json.RawMessage) (RecoveryReencryptionState, error) {
	var kind struct {
		Kind string `json:"kind"`
	}
	if err := json.Unmarshal(source, &kind); err != nil {
		return nil, ErrInvalidRecovery
	}
	switch kind.Kind {
	case "completed":
		var raw struct {
			Kind          string `json:"kind"`
			TargetVersion int64  `json:"targetVersion"`
		}
		if strictRecoveryJSON(source, &raw) != nil || raw.Kind != "completed" {
			return nil, ErrInvalidRecovery
		}
		version, err := cryptocontent.ParseDEKVersion(raw.TargetVersion)
		if err != nil {
			return nil, ErrInvalidRecovery
		}
		return RecoveryReencryptionCompleted{TargetVersion: version}, nil
	case "pending":
		var raw struct {
			Kind       string `json:"kind"`
			Checkpoint struct {
				TargetVersion int64                 `json:"targetVersion"`
				After         *recoveryPositionWire `json:"after"`
			} `json:"checkpoint"`
		}
		if strictRecoveryJSON(source, &raw) != nil || raw.Kind != "pending" {
			return nil, ErrInvalidRecovery
		}
		version, err := cryptocontent.ParseDEKVersion(raw.Checkpoint.TargetVersion)
		if err != nil {
			return nil, ErrInvalidRecovery
		}
		var after *ReencryptionPosition
		if raw.Checkpoint.After != nil {
			position, err := decodeRecoveryPosition(*raw.Checkpoint.After)
			if err != nil {
				return nil, ErrInvalidRecovery
			}
			after = &position
		}
		return RecoveryReencryptionPending{TargetVersion: version, After: after}, nil
	default:
		return nil, ErrInvalidRecovery
	}
}

func encodeRecoveryReencryption(state RecoveryReencryptionState) (json.RawMessage, error) {
	var raw any
	switch value := state.(type) {
	case RecoveryReencryptionCompleted:
		raw = struct {
			Kind          string `json:"kind"`
			TargetVersion int64  `json:"targetVersion"`
		}{Kind: "completed", TargetVersion: int64(value.TargetVersion)}
	case RecoveryReencryptionPending:
		var after *recoveryPositionWire
		if value.After != nil {
			encoded := encodeRecoveryPosition(*value.After)
			after = &encoded
		}
		raw = struct {
			Kind       string `json:"kind"`
			Checkpoint struct {
				TargetVersion int64                 `json:"targetVersion"`
				After         *recoveryPositionWire `json:"after"`
			} `json:"checkpoint"`
		}{Kind: "pending", Checkpoint: struct {
			TargetVersion int64                 `json:"targetVersion"`
			After         *recoveryPositionWire `json:"after"`
		}{TargetVersion: int64(value.TargetVersion), After: after}}
	default:
		return nil, ErrInvalidRecovery
	}
	encoded, err := json.Marshal(raw)
	if err != nil {
		return nil, ErrInvalidRecovery
	}
	return encoded, nil
}

func decodeRecoveryMetadata(wire recoveryMetadataWire) (Metadata, error) {
	object, objectErr := decodeRecoveryObject(wire.Object)
	revision, revisionErr := cryptocontent.ParseObjectRevision(wire.ObjectRevision)
	writeID, writeErr := ParseWriteID(wire.WriteID)
	objectKey, keyErr := ParseObjectKey(wire.ObjectKey)
	version, versionErr := cryptocontent.ParseDEKVersion(wire.DEKVersion)
	if objectErr != nil || revisionErr != nil || writeErr != nil || keyErr != nil || versionErr != nil {
		return Metadata{}, ErrInvalidRecovery
	}
	metadata := Metadata{
		Object: object, ObjectRevision: revision, WriteID: writeID, ObjectKey: objectKey,
		PlaintextBytes: wire.PlaintextBytes, CiphertextBytes: wire.CiphertextBytes,
		CryptoVersion: wire.CryptoVersion, DEKVersion: version, CreatedAtMilli: wire.CreatedAt,
	}
	if ValidateMetadata(metadata) != nil {
		return Metadata{}, ErrInvalidRecovery
	}
	return metadata, nil
}

func encodeRecoveryMetadata(metadata Metadata) recoveryMetadataWire {
	return recoveryMetadataWire{
		Object: encodeRecoveryObject(metadata.Object), ObjectRevision: int64(metadata.ObjectRevision),
		WriteID: string(metadata.WriteID), ObjectKey: string(metadata.ObjectKey),
		PlaintextBytes: metadata.PlaintextBytes, CiphertextBytes: metadata.CiphertextBytes,
		CryptoVersion: metadata.CryptoVersion, DEKVersion: int64(metadata.DEKVersion),
		CreatedAt: metadata.CreatedAtMilli,
	}
}

func decodeRecoveryPosition(wire recoveryPositionWire) (ReencryptionPosition, error) {
	object, objectErr := decodeRecoveryObject(wire.Object)
	revision, revisionErr := cryptocontent.ParseObjectRevision(wire.ObjectRevision)
	if objectErr != nil || revisionErr != nil {
		return ReencryptionPosition{}, ErrInvalidRecovery
	}
	return ReencryptionPosition{Object: object, ObjectRevision: revision}, nil
}

func encodeRecoveryPosition(position ReencryptionPosition) recoveryPositionWire {
	return recoveryPositionWire{Object: encodeRecoveryObject(position.Object), ObjectRevision: int64(position.ObjectRevision)}
}

func decodeRecoveryObject(wire recoveryObjectWire) (ObjectRef, error) {
	object := ObjectRef{Kind: cryptocontent.ObjectKind(wire.Kind), ObjectID: wire.ObjectID}
	if ValidateObjectRef(object) != nil {
		return ObjectRef{}, ErrInvalidRecovery
	}
	return object, nil
}

func encodeRecoveryObject(object ObjectRef) recoveryObjectWire {
	return recoveryObjectWire{Kind: string(object.Kind), ObjectID: object.ObjectID}
}

func strictRecoveryJSON(source []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(source))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return ErrInvalidRecovery
	}
	return nil
}
