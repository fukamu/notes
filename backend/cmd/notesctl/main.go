package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	"github.com/fukamu/notes/backend/internal/access"
	postgresadapter "github.com/fukamu/notes/backend/internal/adapters/postgres"
	"github.com/fukamu/notes/backend/internal/config"
	"github.com/fukamu/notes/backend/migrations"
)

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

func run(arguments []string, stdout io.Writer, stderr io.Writer) int {
	return runWithDependencies(
		arguments,
		stdout,
		stderr,
		os.LookupEnv,
		migrateDatabase,
		prepareE2EDatabase,
	)
}

type migrateFunction func(context.Context, string) error
type prepareE2EFunction func(context.Context, string, string) error

func runWithDependencies(
	arguments []string,
	stdout io.Writer,
	stderr io.Writer,
	lookup func(string) (string, bool),
	migrate migrateFunction,
	prepareE2E prepareE2EFunction,
) int {
	if len(arguments) == 2 && arguments[0] == "config" && arguments[1] == "check" {
		if _, err := config.Load(lookup); err != nil {
			_, _ = fmt.Fprintln(stderr, "configuration invalid")
			return 1
		}
		_, _ = fmt.Fprintln(stdout, "configuration valid")
		return 0
	}
	prepareE2ERequested := len(arguments) == 3 && arguments[0] == "prepare-e2e" &&
		arguments[1] == "--environment=test" && strings.HasPrefix(arguments[2], "--allowed-subject=")
	migrateRequested := len(arguments) == 2 && arguments[0] == "migrate" &&
		strings.HasPrefix(arguments[1], "--environment=")
	if !migrateRequested && !prepareE2ERequested {
		_, _ = fmt.Fprintln(stderr, "usage: notesctl config check | notesctl migrate --environment=local|test | notesctl prepare-e2e --environment=test --allowed-subject=<subject>")
		return 2
	}
	requestedEnvironment := config.Environment(strings.TrimPrefix(arguments[1], "--environment="))
	databaseConfig, err := config.LoadDatabase(lookup)
	if err != nil {
		_, _ = fmt.Fprintln(stderr, "database configuration invalid")
		return 1
	}
	if requestedEnvironment != databaseConfig.Environment ||
		(requestedEnvironment != config.EnvironmentLocal && requestedEnvironment != config.EnvironmentTest) {
		_, _ = fmt.Fprintln(stderr, "migration environment refused")
		return 1
	}
	if err := postgresadapter.ValidateTestDatabaseURL(databaseConfig.URL); err != nil {
		_, _ = fmt.Fprintln(stderr, "migration target refused")
		return 1
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	if prepareE2ERequested {
		if requestedEnvironment != config.EnvironmentTest {
			_, _ = fmt.Fprintln(stderr, "e2e environment refused")
			return 1
		}
		subjectValue := strings.TrimPrefix(arguments[2], "--allowed-subject=")
		if _, err := access.ParseSubject(subjectValue); err != nil {
			_, _ = fmt.Fprintln(stderr, "e2e subject refused")
			return 1
		}
		if err := prepareE2E(ctx, databaseConfig.URL, subjectValue); err != nil {
			_, _ = fmt.Fprintln(stderr, "e2e preparation failed")
			return 1
		}
		_, _ = fmt.Fprintln(stdout, "e2e database prepared")
		return 0
	}
	if err := migrate(ctx, databaseConfig.URL); err != nil {
		_, _ = fmt.Fprintln(stderr, "migration failed")
		return 1
	}
	_, _ = fmt.Fprintln(stdout, "migration complete")
	return 0
}

func prepareE2EDatabase(ctx context.Context, databaseURL string, allowedSubject string) error {
	database, err := postgresadapter.OpenSQL(ctx, databaseURL)
	if err != nil {
		return err
	}
	defer database.Close()
	if _, err := database.ExecContext(ctx, "DROP SCHEMA public CASCADE; CREATE SCHEMA public"); err != nil {
		return err
	}
	migrator, err := postgresadapter.NewMigrator(database, migrations.Files)
	if err != nil {
		return err
	}
	if err := migrator.Up(ctx); err != nil {
		return err
	}
	_, err = database.ExecContext(
		ctx,
		"INSERT INTO launch_allowed_users(user_id, created_at) VALUES ($1, $2)",
		allowedSubject,
		time.Now().UnixMilli(),
	)
	return err
}

func migrateDatabase(ctx context.Context, databaseURL string) error {
	database, err := postgresadapter.OpenSQL(ctx, databaseURL)
	if err != nil {
		return err
	}
	defer database.Close()
	migrator, err := postgresadapter.NewMigrator(database, migrations.Files)
	if err != nil {
		return err
	}
	return migrator.Up(ctx)
}
