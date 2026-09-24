package httpapi

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"time"
)

const maximumIndexBytes = 1_000_000

type HandlerOptions struct {
	StaticDirectory string
	BodyLimit       int64
	Logger          *slog.Logger
}

type statusResponseWriter struct {
	http.ResponseWriter
	status int
}

func (writer *statusResponseWriter) WriteHeader(status int) {
	writer.status = status
	writer.ResponseWriter.WriteHeader(status)
}

func (writer *statusResponseWriter) Unwrap() http.ResponseWriter {
	return writer.ResponseWriter
}

func NewHandler(options HandlerOptions) (http.Handler, error) {
	if options.Logger == nil {
		return nil, errors.New("logger is required")
	}
	if options.BodyLimit < 1 {
		return nil, errors.New("body limit must be positive")
	}
	index, err := loadIndex(options.StaticDirectory)
	if err != nil {
		return nil, err
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", exact("/healthz", processHealth))
	mux.HandleFunc("/readyz", exact("/readyz", readiness))
	mux.HandleFunc("/api", closedAPI)
	mux.HandleFunc("/api/", closedAPI)
	mux.HandleFunc("/", indexHandler(index))

	handler := limitBody(options.BodyLimit, mux)
	handler = recoverPanics(options.Logger, handler)
	handler = logRequests(options.Logger, handler)
	return handler, nil
}

func loadIndex(staticDirectory string) ([]byte, error) {
	path := filepath.Join(staticDirectory, "index.html")
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("open static index: %w", err)
	}
	defer file.Close()

	info, err := file.Stat()
	if err != nil {
		return nil, fmt.Errorf("inspect static index: %w", err)
	}
	if !info.Mode().IsRegular() || info.Size() > maximumIndexBytes {
		return nil, errors.New("static index must be a regular file no larger than 1000000 bytes")
	}
	content, err := io.ReadAll(io.LimitReader(file, maximumIndexBytes+1))
	if err != nil {
		return nil, fmt.Errorf("read static index: %w", err)
	}
	return content, nil
}

func exact(path string, handler http.HandlerFunc) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != path {
			writeError(response, request, http.StatusNotFound, "not_found")
			return
		}
		handler(response, request)
	}
}

func processHealth(response http.ResponseWriter, request *http.Request) {
	if !allowRead(response, request) {
		return
	}
	writeJSON(response, request, http.StatusOK, map[string]string{"status": "ok"})
}

func readiness(response http.ResponseWriter, request *http.Request) {
	if !allowRead(response, request) {
		return
	}
	writeJSON(
		response,
		request,
		http.StatusServiceUnavailable,
		map[string]string{"status": "not_ready"},
	)
}

func closedAPI(response http.ResponseWriter, request *http.Request) {
	writeError(response, request, http.StatusNotFound, "not_found")
}

func indexHandler(index []byte) http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		if request.URL.Path != "/" {
			writeError(response, request, http.StatusNotFound, "not_found")
			return
		}
		if !allowRead(response, request) {
			return
		}
		response.Header().Set("Cache-Control", "no-store")
		response.Header().Set("Content-Type", "text/html; charset=utf-8")
		response.Header().Set("X-Content-Type-Options", "nosniff")
		response.WriteHeader(http.StatusOK)
		if request.Method == http.MethodHead {
			return
		}
		_, _ = response.Write(index)
	}
}

func allowRead(response http.ResponseWriter, request *http.Request) bool {
	if request.Method == http.MethodGet || request.Method == http.MethodHead {
		return true
	}
	response.Header().Set("Allow", "GET, HEAD")
	writeError(response, request, http.StatusMethodNotAllowed, "method_not_allowed")
	return false
}

func limitBody(limit int64, next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.ContentLength > limit {
			writeError(
				response,
				request,
				http.StatusRequestEntityTooLarge,
				"body_too_large",
			)
			return
		}
		limited := http.MaxBytesReader(response, request.Body, limit)
		body, err := io.ReadAll(limited)
		if err != nil {
			var maximumBytesError *http.MaxBytesError
			if errors.As(err, &maximumBytesError) {
				writeError(
					response,
					request,
					http.StatusRequestEntityTooLarge,
					"body_too_large",
				)
				return
			}
			writeError(response, request, http.StatusBadRequest, "invalid_body")
			return
		}
		request.Body = io.NopCloser(bytes.NewReader(body))
		next.ServeHTTP(response, request)
	})
}

func recoverPanics(logger *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		defer func() {
			if recover() != nil {
				logger.Error("request failed", "error_code", "internal_panic")
				writeError(
					response,
					request,
					http.StatusInternalServerError,
					"internal_error",
				)
			}
		}()
		next.ServeHTTP(response, request)
	})
}

func logRequests(logger *slog.Logger, next http.Handler) http.Handler {
	return http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		started := time.Now()
		tracked := &statusResponseWriter{ResponseWriter: response, status: http.StatusOK}
		next.ServeHTTP(tracked, request)
		logger.Info(
			"http request",
			"method", request.Method,
			"path", request.URL.Path,
			"status", tracked.status,
			"duration_ms", time.Since(started).Milliseconds(),
		)
	})
}

func writeError(
	response http.ResponseWriter,
	request *http.Request,
	status int,
	code string,
) {
	writeJSON(response, request, status, map[string]string{"code": code})
}

func writeJSON(
	response http.ResponseWriter,
	request *http.Request,
	status int,
	payload map[string]string,
) {
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Content-Type", "application/json; charset=utf-8")
	response.Header().Set("X-Content-Type-Options", "nosniff")
	response.WriteHeader(status)
	if request != nil && request.Method == http.MethodHead {
		return
	}
	_ = json.NewEncoder(response).Encode(payload)
}
