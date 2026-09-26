package recoverykey_test

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/fukamu/notes/backend/internal/adapters/recoverykey"
	"github.com/fukamu/notes/backend/internal/cryptocontent"
	"github.com/fukamu/notes/backend/internal/identity"
)

func TestDirectoryUnwrapsOnlyExactlyBoundFixtureKey(t *testing.T) {
	root := privateKeyDirectory(t)
	metadata := recoveryMetadata(t)
	raw := make([]byte, 32)
	for index := range raw {
		raw[index] = byte(index + 1)
	}
	writeKeyFile(t, root, metadata, raw)
	directory, err := recoverykey.NewDirectory(root, metadata.VaultID)
	if err != nil {
		t.Fatal(err)
	}
	key, err := directory.UnwrapDataKey(context.Background(), metadata)
	if err != nil {
		t.Fatal(err)
	}
	defer key.Destroy()
	if err := key.Use(func(actual []byte) error {
		if string(actual) != string(raw) {
			t.Fatalf("key bytes differ")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if _, _, err := directory.GenerateDataKey(context.Background(), metadata.VaultID, metadata.DEKVersion); !errors.Is(err, recoverykey.ErrDirectoryOperation) {
		t.Fatalf("generation error=%v", err)
	}
}

func TestDirectoryRejectsMetadataMismatchMalformedAndDuplicateKeyFiles(t *testing.T) {
	metadata := recoveryMetadata(t)
	tests := []struct {
		name  string
		value func() []byte
	}{
		{
			name: "wrong reference",
			value: func() []byte {
				return encodedKeyFile(metadata, make([]byte, 32), map[string]any{"kekKeyReference": "other-reference"})
			},
		},
		{name: "short key", value: func() []byte { return encodedKeyFile(metadata, []byte("short"), nil) }},
		{name: "unknown member", value: func() []byte {
			return append(encodedKeyFile(metadata, make([]byte, 32), nil)[:1], []byte(`"unknown":true,`+string(encodedKeyFile(metadata, make([]byte, 32), nil)[1:]))...)
		}},
		{
			name: "duplicate member",
			value: func() []byte {
				valid := encodedKeyFile(metadata, make([]byte, 32), nil)
				return append(valid[:1], []byte(`"format":"duplicate",`+string(valid[1:]))...)
			},
		},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			root := privateKeyDirectory(t)
			if err := os.WriteFile(filepath.Join(root, "dek-1.json"), testCase.value(), 0o600); err != nil {
				t.Fatal(err)
			}
			directory, err := recoverykey.NewDirectory(root, metadata.VaultID)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := directory.UnwrapDataKey(context.Background(), metadata); !errors.Is(err, recoverykey.ErrDirectoryOperation) {
				t.Fatalf("unwrap error=%v", err)
			}
		})
	}
}

func TestDirectoryRejectsUnsafePermissionsSymlinksAndCancellation(t *testing.T) {
	metadata := recoveryMetadata(t)
	if _, err := recoverykey.NewDirectory("relative", metadata.VaultID); !errors.Is(err, recoverykey.ErrDirectoryOperation) {
		t.Fatalf("relative root error=%v", err)
	}
	root := privateKeyDirectory(t)
	writeKeyFile(t, root, metadata, make([]byte, 32))
	if err := os.Chmod(filepath.Join(root, "dek-1.json"), 0o644); err != nil {
		t.Fatal(err)
	}
	directory, err := recoverykey.NewDirectory(root, metadata.VaultID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := directory.UnwrapDataKey(context.Background(), metadata); !errors.Is(err, recoverykey.ErrDirectoryOperation) {
		t.Fatalf("permission error=%v", err)
	}
	if err := os.Remove(filepath.Join(root, "dek-1.json")); err != nil {
		t.Fatal(err)
	}
	out := filepath.Join(t.TempDir(), "outside.json")
	if err := os.WriteFile(out, encodedKeyFile(metadata, make([]byte, 32), nil), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(out, filepath.Join(root, "dek-1.json")); err != nil {
		t.Fatal(err)
	}
	if _, err := directory.UnwrapDataKey(context.Background(), metadata); !errors.Is(err, recoverykey.ErrDirectoryOperation) {
		t.Fatalf("symlink error=%v", err)
	}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := directory.UnwrapDataKey(cancelled, metadata); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation error=%v", err)
	}
}

func privateKeyDirectory(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	if err := os.Chmod(root, 0o700); err != nil {
		t.Fatal(err)
	}
	return root
}

func recoveryMetadata(t *testing.T) cryptocontent.VaultDEKMetadata {
	t.Helper()
	vaultID, err := identity.ParseVaultID("01991f20-61d2-7000-8000-000000001201")
	if err != nil {
		t.Fatal(err)
	}
	return cryptocontent.VaultDEKMetadata{
		VaultID: vaultID, DEKVersion: 1, KEKReference: "fixture-kek-version-1",
		WrappedDEK: cryptocontent.EncodeBase64URL([]byte("fixture-wrapped-key")), CreatedAtMilli: 1_000,
	}
}

func writeKeyFile(t *testing.T, root string, metadata cryptocontent.VaultDEKMetadata, raw []byte) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(root, "dek-1.json"), encodedKeyFile(metadata, raw, nil), 0o600); err != nil {
		t.Fatal(err)
	}
}

func encodedKeyFile(metadata cryptocontent.VaultDEKMetadata, raw []byte, overrides map[string]any) []byte {
	value := map[string]any{
		"format": recoverykey.FixtureKeyFormat, "vaultId": string(metadata.VaultID),
		"dekVersion": int64(metadata.DEKVersion), "kekKeyReference": metadata.KEKReference,
		"wrappedDek": metadata.WrappedDEK, "rawDek": cryptocontent.EncodeBase64URL(raw),
	}
	for name, replacement := range overrides {
		value[name] = replacement
	}
	encoded, _ := json.Marshal(value)
	return encoded
}
