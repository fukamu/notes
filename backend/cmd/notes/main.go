package main

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	accessadapter "github.com/fukamu/notes/backend/internal/adapters/access"
	postgresadapter "github.com/fukamu/notes/backend/internal/adapters/postgres"
	"github.com/fukamu/notes/backend/internal/config"
	"github.com/fukamu/notes/backend/internal/httpapi"
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
	privateRuntime, closePrivateRuntime, err := composePrivateRuntime(ctx, configuration)
	if err != nil {
		logger.Error("private runtime unavailable", "error_code", "private_runtime_failure")
		return 1
	}
	defer closePrivateRuntime()

	logger.Info(
		"server starting",
		"environment", string(configuration.Environment),
		"address", configuration.HTTPAddress,
	)
	if err := httpapi.Run(ctx, httpapi.ServerOptions{
		Address:             configuration.HTTPAddress,
		StaticDirectory:     configuration.StaticDirectory,
		BodyLimit:           configuration.BodyLimit,
		ShutdownTimeout:     configuration.ShutdownTimeout,
		Logger:              logger,
		PrivateRuntime:      privateRuntime,
		EnableLocalFixtures: configuration.Environment != config.EnvironmentProduction,
	}); err != nil {
		logger.Error("server stopped", "error_code", "server_failure")
		return 1
	}
	logger.Info("server stopped", "reason", "shutdown")
	return 0
}

func composePrivateRuntime(
	ctx context.Context,
	configuration config.Config,
) (*httpapi.PrivateRuntime, func(), error) {
	if configuration.PrivateRuntime == nil {
		return nil, func() {}, nil
	}
	settings := configuration.PrivateRuntime
	startupContext, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	pool, err := postgresadapter.OpenPool(
		startupContext,
		settings.DatabaseURL,
		settings.MaximumConnections,
	)
	if err != nil {
		return nil, func() {}, errors.New("open private database")
	}
	closeRuntime := func() { pool.Close() }
	verifier, err := accessadapter.NewLocalVerifier(
		settings.PublicKey,
		settings.Issuer,
		settings.Audience,
	)
	if err != nil {
		closeRuntime()
		return nil, func() {}, errors.New("configure private identity verifier")
	}
	gate, err := postgresadapter.NewLaunchGateReader(pool)
	if err != nil {
		closeRuntime()
		return nil, func() {}, errors.New("configure launch gate")
	}
	readiness, err := postgresadapter.NewSchemaReadiness(pool, migrations.LatestVersion)
	if err != nil {
		closeRuntime()
		return nil, func() {}, errors.New("configure database readiness")
	}
	legacySync, err := postgresadapter.NewLegacySyncStore(pool)
	if err != nil {
		closeRuntime()
		return nil, func() {}, errors.New("configure legacy sync")
	}
	return &httpapi.PrivateRuntime{
		Verifier:     verifier,
		Gate:         gate,
		Readiness:    readiness,
		LegacySync:   legacySync,
		LegacyOwner:  settings.LegacyOwner,
		PublicOrigin: settings.PublicOrigin,
		Clock:        time.Now,
	}, closeRuntime, nil
}
