package httpapi

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"time"
)

type ServerOptions struct {
	Address                    string
	StaticDirectory            string
	BodyLimit                  int64
	ShutdownTimeout            time.Duration
	Logger                     *slog.Logger
	PrivateRuntime             *PrivateRuntime
	EnableDisconnectedFixtures bool
}

func Run(ctx context.Context, options ServerOptions) error {
	handler, err := NewHandler(HandlerOptions{
		StaticDirectory:            options.StaticDirectory,
		BodyLimit:                  options.BodyLimit,
		Logger:                     options.Logger,
		PrivateRuntime:             options.PrivateRuntime,
		EnableDisconnectedFixtures: options.EnableDisconnectedFixtures,
	})
	if err != nil {
		return err
	}
	server := &http.Server{
		Addr:              options.Address,
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      30 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    1 << 20,
	}
	serveResult := make(chan error, 1)
	go func() {
		serveResult <- server.ListenAndServe()
	}()

	select {
	case serveErr := <-serveResult:
		if errors.Is(serveErr, http.ErrServerClosed) {
			return nil
		}
		return serveErr
	case <-ctx.Done():
		shutdownContext, cancel := context.WithTimeout(
			context.Background(),
			options.ShutdownTimeout,
		)
		defer cancel()
		if shutdownErr := server.Shutdown(shutdownContext); shutdownErr != nil {
			return shutdownErr
		}
		serveErr := <-serveResult
		if errors.Is(serveErr, http.ErrServerClosed) {
			return nil
		}
		return serveErr
	}
}
