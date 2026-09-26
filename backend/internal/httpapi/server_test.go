package httpapi

import (
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"testing"
	"time"
)

func TestRunHTTPServerWaitsForCancelledHandlerAfterShutdownTimeout(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	entered := make(chan struct{})
	cancelled := make(chan struct{})
	release := make(chan struct{})
	handlerReturned := make(chan struct{})
	server := &http.Server{Handler: http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		close(entered)
		<-request.Context().Done()
		close(cancelled)
		<-release
		close(handlerReturned)
		response.WriteHeader(http.StatusServiceUnavailable)
	})}
	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() {
		result <- runHTTPServer(ctx, server, 10*time.Millisecond, func() error {
			return server.Serve(listener)
		})
	}()
	requestResult := make(chan error, 1)
	go func() {
		response, requestErr := http.Get("http://" + listener.Addr().String())
		if response != nil {
			_, _ = io.Copy(io.Discard, response.Body)
			_ = response.Body.Close()
		}
		requestResult <- requestErr
	}()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("handler did not start")
	}
	cancel()
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("Server.Close did not cancel the active request after shutdown timeout")
	}
	select {
	case runErr := <-result:
		t.Fatalf("Run returned before the cancelled handler: %v", runErr)
	case <-time.After(20 * time.Millisecond):
	}
	close(release)
	select {
	case <-handlerReturned:
	case <-time.After(time.Second):
		t.Fatal("handler did not return")
	}
	select {
	case runErr := <-result:
		if !errors.Is(runErr, context.DeadlineExceeded) {
			t.Fatalf("Run error = %v", runErr)
		}
	case <-time.After(time.Second):
		t.Fatal("Run did not return after the handler drained")
	}
	select {
	case <-requestResult:
	case <-time.After(time.Second):
		t.Fatal("client request did not finish")
	}
}

func TestRunHTTPServerPreservesGracefulShutdownResult(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	server := &http.Server{Handler: http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusNoContent)
	})}
	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() {
		result <- runHTTPServer(ctx, server, time.Second, func() error {
			return server.Serve(listener)
		})
	}()
	response, err := http.Get("http://" + listener.Addr().String())
	if err != nil {
		cancel()
		t.Fatal(err)
	}
	_ = response.Body.Close()
	cancel()
	select {
	case runErr := <-result:
		if runErr != nil {
			t.Fatalf("graceful Run error = %v", runErr)
		}
	case <-time.After(time.Second):
		t.Fatal("graceful Run did not return")
	}
}

func TestRunHTTPServerDrainsActiveHandlerBeforeReturningUnexpectedServeError(t *testing.T) {
	baseListener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	serveFailure := errors.New("listener failed")
	failAccept := make(chan struct{})
	listener := &errorAfterFirstAcceptListener{
		Listener: baseListener, fail: failAccept, err: serveFailure,
	}
	defer listener.Close()
	entered := make(chan struct{})
	cancelled := make(chan struct{})
	release := make(chan struct{})
	server := &http.Server{Handler: http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		close(entered)
		<-request.Context().Done()
		close(cancelled)
		<-release
		response.WriteHeader(http.StatusServiceUnavailable)
	})}
	result := make(chan error, 1)
	go func() {
		result <- runHTTPServer(context.Background(), server, time.Second, func() error {
			return server.Serve(listener)
		})
	}()
	requestResult := make(chan error, 1)
	go func() {
		response, requestErr := http.Get("http://" + listener.Addr().String())
		if response != nil {
			_, _ = io.Copy(io.Discard, response.Body)
			_ = response.Body.Close()
		}
		requestResult <- requestErr
	}()
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("handler did not start")
	}
	close(failAccept)
	select {
	case <-cancelled:
	case <-time.After(time.Second):
		t.Fatal("unexpected Serve failure did not cancel the active request")
	}
	select {
	case runErr := <-result:
		t.Fatalf("Run returned before the failed server drained: %v", runErr)
	case <-time.After(20 * time.Millisecond):
	}
	close(release)
	select {
	case runErr := <-result:
		if !errors.Is(runErr, serveFailure) {
			t.Fatalf("Run error = %v", runErr)
		}
	case <-time.After(time.Second):
		t.Fatal("Run did not return after failed server handler drained")
	}
	select {
	case <-requestResult:
	case <-time.After(time.Second):
		t.Fatal("client request did not finish")
	}
}

type errorAfterFirstAcceptListener struct {
	net.Listener
	fail     <-chan struct{}
	err      error
	accepted bool
}

func (listener *errorAfterFirstAcceptListener) Accept() (net.Conn, error) {
	if !listener.accepted {
		listener.accepted = true
		return listener.Listener.Accept()
	}
	<-listener.fail
	return nil, listener.err
}
