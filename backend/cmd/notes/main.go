package main

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	accessadapter "github.com/fukamu/notes/backend/internal/adapters/access"
	accountdeletioncredentialadapter "github.com/fukamu/notes/backend/internal/adapters/accountdeletioncredential"
	contentcryptoadapter "github.com/fukamu/notes/backend/internal/adapters/contentcrypto"
	localfixtureadapter "github.com/fukamu/notes/backend/internal/adapters/localfixture"
	objectstorageadapter "github.com/fukamu/notes/backend/internal/adapters/objectstorage"
	postgresadapter "github.com/fukamu/notes/backend/internal/adapters/postgres"
	recoverykeyadapter "github.com/fukamu/notes/backend/internal/adapters/recoverykey"
	"github.com/fukamu/notes/backend/internal/config"
	"github.com/fukamu/notes/backend/internal/httpapi"
	"github.com/fukamu/notes/backend/internal/localfixture"
	"github.com/fukamu/notes/backend/internal/runtimefoundation"
	"github.com/fukamu/notes/backend/internal/syncv2"
	"github.com/fukamu/notes/backend/internal/telemetry"
	"github.com/fukamu/notes/backend/migrations"
)

func main() {
	os.Exit(run())
}

func run() int {
	bootstrapLogger := telemetry.NewLogger(os.Stderr, slog.LevelInfo)
	configuration, err := config.Load(os.LookupEnv)
	if err != nil {
		bootstrapLogger.Error(
			"configuration rejected",
			"error_code",
			"invalid_configuration",
		)
		return 1
	}
	logger := telemetry.NewLogger(os.Stderr, configuration.LogLevel)
	ctx, stop := signal.NotifyContext(
		context.Background(),
		os.Interrupt,
		syscall.SIGTERM,
	)
	defer stop()
	runtime, closeRuntime, err := composeRuntime(ctx, configuration)
	if err != nil {
		logger.Error("runtime unavailable", "error_code", "runtime_failure")
		return 1
	}
	defer closeRuntime()

	logger.Info(
		"server starting",
		"environment", string(configuration.Environment),
		"address", configuration.HTTPAddress,
		"application_profile", string(configuration.ApplicationProfile),
	)
	if err := httpapi.Run(ctx, httpapi.ServerOptions{
		Address:             configuration.HTTPAddress,
		StaticDirectory:     configuration.StaticDirectory,
		BodyLimit:           configuration.BodyLimit,
		ShutdownTimeout:     configuration.ShutdownTimeout,
		Logger:              logger,
		PrivateRuntime:      runtime.private,
		EnableLocalFixtures: configuration.ApplicationProfile == config.ApplicationProfileLocalFixture,
	}); err != nil {
		logger.Error("server stopped", "error_code", "server_failure")
		return 1
	}
	logger.Info("server stopped", "reason", "shutdown")
	return 0
}

type runtimeComposition struct {
	private      *httpapi.PrivateRuntime
	localFixture *runtimefoundation.LocalFixture
}

func composeRuntime(
	ctx context.Context,
	configuration config.Config,
) (runtimeComposition, func(), error) {
	if err := validateRuntimeConfiguration(configuration); err != nil {
		return runtimeComposition{}, func() {}, err
	}
	if configuration.PrivateRuntime == nil {
		return runtimeComposition{}, func() {}, nil
	}
	settings := configuration.PrivateRuntime
	verifier, err := accessadapter.NewLocalVerifier(
		settings.PublicKey,
		settings.Issuer,
		settings.Audience,
	)
	if err != nil {
		return runtimeComposition{}, func() {}, errors.New("configure private identity verifier")
	}
	var fixtureLayout localfixtureadapter.Layout
	var fixtureMetadataReady bool
	if configuration.LocalFixture != nil {
		fixtureLayout, err = localfixtureadapter.OpenLayout(configuration.LocalFixture.PrivateRoot)
		if err != nil {
			return runtimeComposition{}, func() {}, errors.New("open local fixture directories")
		}
		if _, err := recoverykeyadapter.LoadFixtureMetadata(
			fixtureLayout.KeyDirectory,
			configuration.LocalFixture.VaultID,
		); err != nil {
			return runtimeComposition{}, func() {}, errors.New("load local fixture key")
		}
		fixtureMetadataReady = true
	}
	startupContext, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	pool, err := postgresadapter.OpenPool(
		startupContext,
		settings.DatabaseURL,
		settings.MaximumConnections,
	)
	if err != nil {
		return runtimeComposition{}, func() {}, errors.New("open private database")
	}
	closeRuntime := func() { pool.Close() }
	gate, err := postgresadapter.NewLaunchGateReader(pool)
	if err != nil {
		closeRuntime()
		return runtimeComposition{}, func() {}, errors.New("configure launch gate")
	}
	schemaReadiness, err := postgresadapter.NewSchemaReadiness(pool, migrations.LatestVersion)
	if err != nil {
		closeRuntime()
		return runtimeComposition{}, func() {}, errors.New("configure database readiness")
	}
	legacySync, err := postgresadapter.NewLegacySyncStore(pool)
	if err != nil {
		closeRuntime()
		return runtimeComposition{}, func() {}, errors.New("configure legacy sync")
	}
	readiness := runtimefoundation.Readiness(schemaReadiness)
	composition := runtimeComposition{}
	if configuration.LocalFixture != nil {
		if !fixtureMetadataReady {
			closeRuntime()
			return runtimeComposition{}, func() {}, errors.New("local fixture key unavailable")
		}
		fixtureConfig := configuration.LocalFixture
		metadata, metadataErr := recoverykeyadapter.LoadFixtureMetadata(
			fixtureLayout.KeyDirectory,
			fixtureConfig.VaultID,
		)
		if metadataErr != nil {
			closeRuntime()
			return runtimeComposition{}, func() {}, errors.New("load local fixture key")
		}
		seed, seedErr := localfixture.NewSeed(
			fixtureConfig.AllowedSubject,
			fixtureConfig.AccountID,
			fixtureConfig.VaultID,
			fixtureConfig.SessionID,
			fixtureConfig.SessionEpoch,
			fixtureConfig.SessionToken,
			metadata,
		)
		if seedErr != nil {
			closeRuntime()
			return runtimeComposition{}, func() {}, errors.New("configure local fixture seed")
		}
		fixtureStore, storeErr := postgresadapter.NewLocalFixtureStore(pool, seed)
		if storeErr != nil {
			closeRuntime()
			return runtimeComposition{}, func() {}, errors.New("configure local fixture database")
		}
		sessionStore, sessionErr := postgresadapter.NewSessionStore(pool)
		if sessionErr != nil {
			closeRuntime()
			return runtimeComposition{}, func() {}, errors.New("configure local fixture sessions")
		}
		sessionResolver, resolverErr := postgresadapter.NewSessionResolver(sessionStore)
		if resolverErr != nil {
			closeRuntime()
			return runtimeComposition{}, func() {}, errors.New("configure local fixture sessions")
		}
		objects, objectErr := objectstorageadapter.NewDirectory(fixtureLayout.ObjectDirectory)
		if objectErr != nil {
			closeRuntime()
			return runtimeComposition{}, func() {}, errors.New("configure local fixture object storage")
		}
		nonces, nonceErr := contentcryptoadapter.NewDirectoryNonceReservations(fixtureLayout.NonceDirectory)
		if nonceErr != nil {
			closeRuntime()
			return runtimeComposition{}, func() {}, errors.New("configure local fixture nonce reservations")
		}
		keys, keyErr := recoverykeyadapter.NewDirectory(fixtureLayout.KeyDirectory, fixtureConfig.VaultID)
		if keyErr != nil {
			closeRuntime()
			return runtimeComposition{}, func() {}, errors.New("configure local fixture key management")
		}
		cursors, cursorErr := syncv2.NewCursorAuthenticator(fixtureConfig.CursorHMACKey[:])
		if cursorErr != nil {
			closeRuntime()
			return runtimeComposition{}, func() {}, errors.New("configure local fixture cursor authentication")
		}
		deletionCredentials, deletionErr := accountdeletioncredentialadapter.New(
			fixtureConfig.DeletionHMACKey[:],
		)
		if deletionErr != nil {
			closeRuntime()
			return runtimeComposition{}, func() {}, errors.New("configure local fixture deletion credentials")
		}
		directoryReadiness, directoryErr := localfixtureadapter.NewReadiness(
			fixtureConfig.PrivateRoot,
			fixtureConfig.VaultID,
		)
		if directoryErr != nil {
			closeRuntime()
			return runtimeComposition{}, func() {}, errors.New("configure local fixture directory readiness")
		}
		aggregate, aggregateErr := runtimefoundation.NewAggregateReadiness(
			schemaReadiness,
			fixtureStore,
			directoryReadiness,
		)
		if aggregateErr != nil || aggregate.Check(startupContext) != nil {
			closeRuntime()
			return runtimeComposition{}, func() {}, errors.New("local fixture is not ready")
		}
		foundation, foundationErr := runtimefoundation.NewLocalFixture(
			runtimefoundation.LocalFixtureOptions{
				Context: seed.Context, Sessions: sessionResolver, Objects: objects,
				NonceReservations: nonces, Keys: keys, Cursors: cursors,
				DeletionCredentials: deletionCredentials,
			},
		)
		if foundationErr != nil {
			closeRuntime()
			return runtimeComposition{}, func() {}, errors.New("configure local fixture foundation")
		}
		composition.localFixture = foundation
		readiness = aggregate
	}
	composition.private = &httpapi.PrivateRuntime{
		Verifier:     verifier,
		Gate:         gate,
		Readiness:    readiness,
		LegacySync:   legacySync,
		LegacyOwner:  settings.LegacyOwner,
		PublicOrigin: settings.PublicOrigin,
		Clock:        time.Now,
	}
	return composition, closeRuntime, nil
}

func validateRuntimeConfiguration(configuration config.Config) error {
	switch configuration.ApplicationProfile {
	case "", config.ApplicationProfileDisabled:
		if configuration.LocalFixture != nil {
			return errors.New("disabled application profile contains local fixture configuration")
		}
		return nil
	case config.ApplicationProfileLocalFixture:
	default:
		return errors.New("unknown application profile")
	}
	if configuration.Environment == config.EnvironmentProduction || configuration.PrivateRuntime == nil ||
		configuration.LocalFixture == nil {
		return errors.New("local fixture profile is unavailable")
	}
	private := configuration.PrivateRuntime
	fixture := configuration.LocalFixture
	if fixture.DatabaseURL != private.DatabaseURL || fixture.PublicOrigin == nil || private.PublicOrigin == nil ||
		fixture.PublicOrigin.String() != private.PublicOrigin.String() ||
		fixture.AllowedSubject != private.LegacyOwner ||
		fixture.ObjectDirectory != filepath.Join(fixture.PrivateRoot, localfixture.ObjectDirectoryName) ||
		fixture.NonceDirectory != filepath.Join(fixture.PrivateRoot, localfixture.NonceDirectoryName) ||
		fixture.KeyDirectory != filepath.Join(fixture.PrivateRoot, localfixture.KeyDirectoryName) ||
		localfixture.ValidateDatabaseURL(fixture.DatabaseURL) != nil {
		return errors.New("local fixture profile does not match private runtime")
	}
	return nil
}
