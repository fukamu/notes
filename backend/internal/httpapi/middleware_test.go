package httpapi

import (
	"bytes"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/fukamu/notes/backend/internal/telemetry"
)

func TestRecoverPanicsReturnsFixedErrorWithoutPanicValue(t *testing.T) {
	t.Parallel()
	var logs bytes.Buffer
	logger := telemetry.NewLogger(&logs, slog.LevelDebug)
	handler := recoverPanics(logger, http.HandlerFunc(
		func(http.ResponseWriter, *http.Request) {
			panic("raw-panic-value")
		},
	))
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, httptest.NewRequest(http.MethodGet, "/", nil))

	if response.Code != http.StatusInternalServerError {
		t.Fatalf("status = %d", response.Code)
	}
	if response.Body.String() != "{\"code\":\"internal_error\"}\n" {
		t.Fatalf("body = %q", response.Body.String())
	}
	if bytes.Contains(logs.Bytes(), []byte("raw-panic-value")) {
		t.Fatalf("log contains panic value: %s", logs.String())
	}
}
