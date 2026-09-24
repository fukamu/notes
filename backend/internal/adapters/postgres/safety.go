package postgres

import (
	"errors"
	"net"
	"net/url"
	"strings"
)

const TestDatabaseName = "fukamu_notes_go_test"

func ValidateTestDatabaseURL(rawURL string) error {
	parsed, err := url.Parse(rawURL)
	if err != nil || (parsed.Scheme != "postgres" && parsed.Scheme != "postgresql") {
		return errors.New("test database URL must be a PostgreSQL URL")
	}
	hostname := strings.ToLower(parsed.Hostname())
	if hostname != "localhost" && hostname != "127.0.0.1" && hostname != "::1" {
		return errors.New("test database host is not allowlisted")
	}
	if parsed.Path != "/"+TestDatabaseName {
		return errors.New("test database name is not allowlisted")
	}
	for key, values := range parsed.Query() {
		if key != "sslmode" || len(values) != 1 {
			return errors.New("test database URL contains a disallowed parameter")
		}
	}
	if port := parsed.Port(); port != "" {
		if _, err := net.LookupPort("tcp", port); err != nil {
			return errors.New("test database port is invalid")
		}
	}
	return nil
}
