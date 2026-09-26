package main

import (
	"net/url"
	"path/filepath"
	"testing"

	"github.com/fukamu/notes/backend/internal/config"
	"github.com/fukamu/notes/backend/internal/localfixture"
)

func TestValidateRuntimeConfigurationKeepsDefaultProfileClosed(t *testing.T) {
	t.Parallel()
	if err := validateRuntimeConfiguration(config.Config{}); err != nil {
		t.Fatalf("zero/default configuration error = %v", err)
	}
	if err := validateRuntimeConfiguration(config.Config{
		ApplicationProfile: config.ApplicationProfileDisabled,
		LocalFixture:       &config.LocalFixtureConfig{},
	}); err == nil {
		t.Fatal("disabled profile accepted a local fixture graph")
	}
}

func TestDisconnectedFixturesStaySeparateFromApplicationProfiles(t *testing.T) {
	t.Parallel()
	for _, test := range []struct {
		name        string
		environment config.Environment
		enabled     bool
	}{
		{name: "local", environment: config.EnvironmentLocal, enabled: true},
		{name: "test", environment: config.EnvironmentTest, enabled: true},
		{name: "production", environment: config.EnvironmentProduction, enabled: false},
	} {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if actual := disconnectedFixturesEnabled(test.environment); actual != test.enabled {
				t.Fatalf("disconnectedFixturesEnabled(%q) = %t, want %t", test.environment, actual, test.enabled)
			}
		})
	}
}

func TestValidateRuntimeConfigurationRequiresExactPrivateRuntimeReuseBeforeIO(t *testing.T) {
	t.Parallel()
	valid := validRuntimeConfig(t)
	if err := validateRuntimeConfiguration(valid); err != nil {
		t.Fatalf("valid configuration error = %v", err)
	}
	for _, test := range []struct {
		name   string
		mutate func(*config.Config)
	}{
		{name: "production", mutate: func(value *config.Config) { value.Environment = config.EnvironmentProduction }},
		{name: "missing private runtime", mutate: func(value *config.Config) { value.PrivateRuntime = nil }},
		{name: "missing fixture", mutate: func(value *config.Config) { value.LocalFixture = nil }},
		{name: "database mismatch", mutate: func(value *config.Config) { value.LocalFixture.DatabaseURL += "?sslmode=disable" }},
		{name: "origin mismatch", mutate: func(value *config.Config) {
			value.LocalFixture.PublicOrigin, _ = url.Parse("http://localhost:8081")
		}},
		{name: "launch subject mismatch", mutate: func(value *config.Config) {
			value.LocalFixture.AllowedSubject = "other-owner"
		}},
		{name: "unsafe database", mutate: func(value *config.Config) {
			value.PrivateRuntime.DatabaseURL = "postgres://notes:secret@db.example/fukamu_notes_go_test"
			value.LocalFixture.DatabaseURL = value.PrivateRuntime.DatabaseURL
		}},
		{name: "derived path mismatch", mutate: func(value *config.Config) {
			value.LocalFixture.KeyDirectory = filepath.Join(value.LocalFixture.PrivateRoot, "other")
		}},
	} {
		test := test
		t.Run(test.name, func(t *testing.T) {
			copy := validRuntimeConfig(t)
			test.mutate(&copy)
			if err := validateRuntimeConfiguration(copy); err == nil {
				t.Fatal("unsafe runtime configuration was accepted")
			}
		})
	}
}

func validRuntimeConfig(t *testing.T) config.Config {
	t.Helper()
	origin, err := url.Parse("http://localhost:8080")
	if err != nil {
		t.Fatal(err)
	}
	root := "/tmp/fukamu-notes-local-fixture-test"
	databaseURL := "postgres://notes:secret@127.0.0.1/fukamu_notes_go_test"
	return config.Config{
		Environment:        config.EnvironmentTest,
		ApplicationProfile: config.ApplicationProfileLocalFixture,
		PrivateRuntime: &config.PrivateRuntimeConfig{
			DatabaseURL: databaseURL, PublicOrigin: origin, LegacyOwner: "fixture-owner",
		},
		LocalFixture: &config.LocalFixtureConfig{
			DatabaseURL: databaseURL, PublicOrigin: origin, AllowedSubject: "fixture-owner", PrivateRoot: root,
			ObjectDirectory: filepath.Join(root, localfixture.ObjectDirectoryName),
			NonceDirectory:  filepath.Join(root, localfixture.NonceDirectoryName),
			KeyDirectory:    filepath.Join(root, localfixture.KeyDirectoryName),
		},
	}
}
