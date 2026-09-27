package postgres

import (
	"errors"
	"net/url"
	"strings"

	"github.com/fukamu/notes/backend/internal/localfixture"
	"github.com/jackc/pgx/v5"
)

const TestDatabaseName = localfixture.DisposableDatabaseName

var ErrProductionDatabaseTarget = errors.New("production database target refused")

func ValidateTestDatabaseURL(rawURL string) error {
	return localfixture.ValidateDatabaseURL(rawURL)
}

// ValidateProductionDatabaseTarget requires the operator's expected host and
// database name to match both the URL and pgx's effective configuration. It
// deliberately rejects connection-service and host/database override options
// so a reviewed command cannot be redirected by an opaque client setting.
func ValidateProductionDatabaseTarget(rawURL string, expectedHost string, expectedDatabase string) error {
	if len(rawURL) < 1 || len(rawURL) > 16_384 || len(expectedHost) < 1 || len(expectedHost) > 253 ||
		len(expectedDatabase) < 1 || len(expectedDatabase) > 63 ||
		strings.TrimSpace(expectedHost) != expectedHost || strings.TrimSpace(expectedDatabase) != expectedDatabase ||
		strings.ContainsAny(expectedHost+expectedDatabase, "\r\n\x00/@") {
		return ErrProductionDatabaseTarget
	}
	parsed, err := url.Parse(rawURL)
	if err != nil || (parsed.Scheme != "postgres" && parsed.Scheme != "postgresql") ||
		parsed.Opaque != "" || parsed.User == nil || parsed.Hostname() != expectedHost ||
		parsed.Path != "/"+expectedDatabase || parsed.RawPath != "" || parsed.Fragment != "" {
		return ErrProductionDatabaseTarget
	}
	query, err := url.ParseQuery(parsed.RawQuery)
	if err != nil {
		return ErrProductionDatabaseTarget
	}
	for key, values := range query {
		if len(values) != 1 || key == "host" || key == "hostaddr" || key == "database" ||
			key == "dbname" || key == "service" || key == "servicefile" {
			return ErrProductionDatabaseTarget
		}
	}
	sslModes := query["sslmode"]
	if len(sslModes) != 1 || (sslModes[0] != "require" && sslModes[0] != "verify-ca" && sslModes[0] != "verify-full") {
		return ErrProductionDatabaseTarget
	}
	effective, err := pgx.ParseConfig(rawURL)
	if err != nil || effective.Host != expectedHost || effective.Database != expectedDatabase || effective.TLSConfig == nil {
		return ErrProductionDatabaseTarget
	}
	return nil
}
