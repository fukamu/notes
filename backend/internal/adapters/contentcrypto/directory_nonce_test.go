package contentcrypto_test

import (
	"context"
	"errors"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/fukamu/notes/backend/internal/adapters/contentcrypto"
	"github.com/fukamu/notes/backend/internal/cryptocontent"
	"github.com/fukamu/notes/backend/internal/identity"
)

func TestDirectoryNonceReservationsPersistAndRaceSafely(t *testing.T) {
	root := secureNonceDirectory(t)
	reservations, err := contentcrypto.NewDirectoryNonceReservations(root)
	if err != nil {
		t.Fatal(err)
	}
	vaultID, _ := identity.ParseVaultID("01991f20-61d2-7000-8000-000000000201")
	version, _ := cryptocontent.ParseDEKVersion(2)
	const nonce = "AAAAAAAAAAAAAAAA"
	results := make(chan bool, 16)
	errorsFound := make(chan error, 16)
	var group sync.WaitGroup
	for range 16 {
		group.Add(1)
		go func() {
			defer group.Done()
			reserved, reserveErr := reservations.ReserveNonce(context.Background(), vaultID, version, nonce)
			results <- reserved
			errorsFound <- reserveErr
		}()
	}
	group.Wait()
	close(results)
	close(errorsFound)
	for err := range errorsFound {
		if err != nil {
			t.Fatal(err)
		}
	}
	winners := 0
	for result := range results {
		if result {
			winners++
		}
	}
	if winners != 1 {
		t.Fatalf("reservation winners = %d", winners)
	}
	restarted, err := contentcrypto.NewDirectoryNonceReservations(root)
	if err != nil {
		t.Fatal(err)
	}
	if reserved, err := restarted.ReserveNonce(context.Background(), vaultID, version, nonce); err != nil || reserved {
		t.Fatalf("restart reservation = %t, error = %v", reserved, err)
	}
	entries, err := os.ReadDir(root)
	if err != nil || len(entries) != 1 {
		t.Fatalf("entries = %#v, error = %v", entries, err)
	}
	if strings.Contains(entries[0].Name(), string(vaultID)) || strings.Contains(entries[0].Name(), nonce) {
		t.Fatalf("reservation filename disclosed scope: %q", entries[0].Name())
	}
	info, err := entries[0].Info()
	if err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("reservation mode = %v, error = %v", info.Mode().Perm(), err)
	}
}

func TestDirectoryNonceReservationsRejectInvalidInputAndCancellation(t *testing.T) {
	if _, err := contentcrypto.NewDirectoryNonceReservations("relative"); !errors.Is(err, contentcrypto.ErrDirectoryNonceReservation) {
		t.Fatalf("relative root error = %v", err)
	}
	root := secureNonceDirectory(t)
	reservations, err := contentcrypto.NewDirectoryNonceReservations(root)
	if err != nil {
		t.Fatal(err)
	}
	vaultID, _ := identity.ParseVaultID("01991f20-61d2-7000-8000-000000000201")
	version, _ := cryptocontent.ParseDEKVersion(2)
	if _, err := reservations.ReserveNonce(context.Background(), vaultID, version, "bad"); !errors.Is(err, contentcrypto.ErrDirectoryNonceReservation) {
		t.Fatalf("bad nonce error = %v", err)
	}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := reservations.ReserveNonce(cancelled, vaultID, version, "AAAAAAAAAAAAAAAA"); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation error = %v", err)
	}
}

func secureNonceDirectory(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	if err := os.Chmod(root, 0o700); err != nil {
		t.Fatal(err)
	}
	return root
}
