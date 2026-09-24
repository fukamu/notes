package main

import (
	"context"
	"fmt"
	"io"
	"os"
	"strings"
	"time"

	postgresadapter "github.com/fukamu/notes/backend/internal/adapters/postgres"
	"github.com/fukamu/notes/backend/internal/config"
	"github.com/fukamu/notes/backend/migrations"
)

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

func run(arguments []string, stdout io.Writer, stderr io.Writer) int {
	return runWithDependencies(arguments, stdout, stderr, os.LookupEnv, migrateDatabase)
}

type migrateFunction func(context.Context, string) error

func runWithDependencies(
	arguments []string,
	stdout io.Writer,
	stderr io.Writer,
	lookup func(string) (string, bool),
	migrate migrateFunction,
) int {
	if len(arguments) == 2 && arguments[0] == "config" && arguments[1] == "check" {
		if _, err := config.Load(lookup); err != nil {
			_, _ = fmt.Fprintln(stderr, "configuration invalid")
			return 1
		}
		_, _ = fmt.Fprintln(stdout, "configuration valid")
		return 0
	}
	if len(arguments) != 2 || arguments[0] != "migrate" || !strings.HasPrefix(arguments[1], "--environment=") {
		_, _ = fmt.Fprintln(stderr, "usage: notesctl config check | notesctl migrate --environment=local|test")
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
	if err := migrate(ctx, databaseConfig.URL); err != nil {
		_, _ = fmt.Fprintln(stderr, "migration failed")
		return 1
	}
	_, _ = fmt.Fprintln(stdout, "migration complete")
	return 0
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
