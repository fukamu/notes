package postgres

import (
	"github.com/fukamu/notes/backend/internal/localfixture"
)

const TestDatabaseName = localfixture.DisposableDatabaseName

func ValidateTestDatabaseURL(rawURL string) error {
	return localfixture.ValidateDatabaseURL(rawURL)
}
