package httpapi

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"sync"
	"time"
)

type ServerOptions struct {
	Address                    string
	StaticDirectory            string
	BodyLimit                  int64
	ShutdownTimeout            time.Duration
	Logger                     *slog.Logger
	PrivateRuntime             *PrivateRuntime
	SyncV2Runtime              *SyncV2Runtime
	LegalRuntime               *LegalRuntime
	BillingCancellationRuntime *BillingCancellationRuntime
	AccountDeletionRuntime     *AccountDeletionRuntime
	PrivacyRequestRuntime      *PrivacyRequestRuntime
	DisableLegacySync          bool
	EnableDisconnectedFixtures bool
}

func Run(ctx context.Context, options ServerOptions) error {
	handler, err := NewHandler(HandlerOptions{
		StaticDirectory:            options.StaticDirectory,
		BodyLimit:                  options.BodyLimit,
		Logger:                     options.Logger,
		PrivateRuntime:             options.PrivateRuntime,
		SyncV2Runtime:              options.SyncV2Runtime,
		LegalRuntime:               options.LegalRuntime,
		BillingCancellationRuntime: options.BillingCancellationRuntime,
		AccountDeletionRuntime:     options.AccountDeletionRuntime,
		PrivacyRequestRuntime:      options.PrivacyRequestRuntime,
		DisableLegacySync:          options.DisableLegacySync,
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
	return runHTTPServer(ctx, server, options.ShutdownTimeout, server.ListenAndServe)
}

// handlerLifecycle closes admission only after net/http has stopped its
// listeners, then provides a race-free drain barrier for handlers that were
// already admitted. A WaitGroup cannot safely express this boundary because a
// ServeHTTP Add may race a shutdown Wait.
type handlerLifecycle struct {
	delegate http.Handler

	mutex   sync.Mutex
	closing bool
	active  int
	drained chan struct{}
}

func newHandlerLifecycle(delegate http.Handler) *handlerLifecycle {
	return &handlerLifecycle{delegate: delegate, drained: make(chan struct{})}
}

func (lifecycle *handlerLifecycle) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if lifecycle == nil || lifecycle.delegate == nil {
		http.Error(response, http.StatusText(http.StatusServiceUnavailable), http.StatusServiceUnavailable)
		return
	}
	lifecycle.mutex.Lock()
	if lifecycle.closing {
		lifecycle.mutex.Unlock()
		http.Error(response, http.StatusText(http.StatusServiceUnavailable), http.StatusServiceUnavailable)
		return
	}
	lifecycle.active++
	lifecycle.mutex.Unlock()
	defer lifecycle.leave()
	lifecycle.delegate.ServeHTTP(response, request)
}

func (lifecycle *handlerLifecycle) leave() {
	lifecycle.mutex.Lock()
	defer lifecycle.mutex.Unlock()
	if lifecycle.active < 1 {
		panic("HTTP handler lifecycle released without an active request")
	}
	lifecycle.active--
	if lifecycle.closing && lifecycle.active == 0 {
		close(lifecycle.drained)
	}
}

func (lifecycle *handlerLifecycle) stopAdmission() <-chan struct{} {
	lifecycle.mutex.Lock()
	defer lifecycle.mutex.Unlock()
	if lifecycle.closing {
		return lifecycle.drained
	}
	lifecycle.closing = true
	if lifecycle.active == 0 {
		close(lifecycle.drained)
	}
	return lifecycle.drained
}

func runHTTPServer(
	ctx context.Context,
	server *http.Server,
	shutdownTimeout time.Duration,
	serve func() error,
) error {
	if ctx == nil || server == nil || server.Handler == nil || serve == nil {
		return errors.New("complete HTTP server runtime is required")
	}
	lifecycle := newHandlerLifecycle(server.Handler)
	server.Handler = lifecycle
	serveResult := make(chan error, 1)
	go func() {
		serveResult <- serve()
	}()

	select {
	case serveErr := <-serveResult:
		_ = server.Close()
		<-lifecycle.stopAdmission()
		if errors.Is(serveErr, http.ErrServerClosed) {
			return nil
		}
		return serveErr
	case <-ctx.Done():
		shutdownContext, cancel := context.WithTimeout(
			context.Background(),
			shutdownTimeout,
		)
		defer cancel()
		shutdownErr := server.Shutdown(shutdownContext)
		drained := lifecycle.stopAdmission()
		if shutdownErr != nil {
			// Shutdown has already stopped listener admission. Close cancels
			// active request contexts; the explicit lifecycle barrier below
			// keeps Run from returning (and its caller from closing runtime
			// resources) until every admitted handler has actually returned.
			_ = server.Close()
		}
		<-drained
		serveErr := <-serveResult
		if shutdownErr != nil {
			return shutdownErr
		}
		if errors.Is(serveErr, http.ErrServerClosed) {
			return nil
		}
		return serveErr
	}
}
