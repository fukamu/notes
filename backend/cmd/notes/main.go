package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"syscall"

	"github.com/fukamu/notes/backend/internal/config"
	"github.com/fukamu/notes/backend/internal/httpapi"
	"github.com/fukamu/notes/backend/internal/telemetry"
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

	logger.Info(
		"server starting",
		"environment", string(configuration.Environment),
		"address", configuration.HTTPAddress,
	)
	if err := httpapi.Run(ctx, httpapi.ServerOptions{
		Address:         configuration.HTTPAddress,
		StaticDirectory: configuration.StaticDirectory,
		BodyLimit:       configuration.BodyLimit,
		ShutdownTimeout: configuration.ShutdownTimeout,
		Logger:          logger,
	}); err != nil {
		logger.Error("server stopped", "error_code", "server_failure")
		return 1
	}
	logger.Info("server stopped", "reason", "shutdown")
	return 0
}
