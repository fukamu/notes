package telemetry_test

import (
	"bytes"
	"log/slog"
	"strings"
	"testing"

	"github.com/fukamu/notes/backend/internal/telemetry"
)

func TestLoggerRedactsSensitiveAttributes(t *testing.T) {
	t.Parallel()
	var output bytes.Buffer
	logger := telemetry.NewLogger(&output, slog.LevelDebug)
	logger.Info(
		"request",
		"method", "GET",
		"authorization", "Bearer raw-credential",
		"session_cookie", "raw-cookie",
		"access-token", "raw-token",
		"providerSecret", "raw-secret",
		"request_body", "raw-body",
		"raw_query", "return_to=/private",
	)

	logLine := output.String()
	for _, forbidden := range []string{
		"raw-credential",
		"raw-cookie",
		"raw-token",
		"raw-secret",
		"raw-body",
		"/private",
	} {
		if strings.Contains(logLine, forbidden) {
			t.Fatalf("log contains sensitive value %q: %s", forbidden, logLine)
		}
	}
	if !strings.Contains(logLine, `"method":"GET"`) {
		t.Fatalf("log omitted safe attribute: %s", logLine)
	}
	if count := strings.Count(logLine, "[REDACTED]"); count != 6 {
		t.Fatalf("redaction count = %d, want 6: %s", count, logLine)
	}
}
