package postgres

import (
	"testing"
	"time"
)

func TestPoolConfigurationKeepsRuntimeLifecycleSettingsCentralized(t *testing.T) {
	const databaseURL = "postgres://notes_test:local@127.0.0.1:55432/fukamu_notes_go_test?sslmode=disable"
	configuration, err := PoolConfiguration(databaseURL, 16)
	if err != nil {
		t.Fatal(err)
	}
	if configuration.MaxConns != 16 || configuration.MinConns != 0 ||
		configuration.MaxConnLifetime != 30*time.Minute ||
		configuration.MaxConnIdleTime != 5*time.Minute ||
		configuration.ConnConfig.Tracer != nil {
		t.Fatalf("pool configuration drifted: %#v", configuration)
	}

	configuration.MaxConns = 1
	fresh, err := PoolConfiguration(databaseURL, 16)
	if err != nil {
		t.Fatal(err)
	}
	if fresh.MaxConns != 16 {
		t.Fatal("pool configuration was shared across callers")
	}
}
