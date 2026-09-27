package postgres

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"errors"
	"fmt"
	"io/fs"

	"github.com/pressly/goose/v3"
	"github.com/pressly/goose/v3/lock"
)

const gooseVersionTable = "notes_goose_versions"

var ErrMigrationDrift = errors.New("database migration checksum mismatch")

type migrationChecksum struct {
	Version  int64
	Path     string
	Checksum string
}

type Migrator struct {
	database  *sql.DB
	provider  *goose.Provider
	checksums []migrationChecksum
}

func NewMigrator(database *sql.DB, migrations fs.FS) (*Migrator, error) {
	if database == nil {
		return nil, errors.New("database is required")
	}
	locker, err := lock.NewPostgresSessionLocker()
	if err != nil {
		return nil, errors.New("configure migration lock")
	}
	provider, err := goose.NewProvider(
		goose.DialectPostgres,
		database,
		migrations,
		goose.WithTableName(gooseVersionTable),
		goose.WithSessionLocker(locker),
		goose.WithDisableGlobalRegistry(true),
	)
	if err != nil {
		return nil, errors.New("configure migrations")
	}
	checksums, err := collectChecksums(provider, migrations)
	if err != nil {
		return nil, err
	}
	return &Migrator{database: database, provider: provider, checksums: checksums}, nil
}

func (migrator *Migrator) Up(ctx context.Context) error {
	if err := migrator.ensureChecksumTable(ctx); err != nil {
		return err
	}
	currentVersion, err := migrator.provider.GetDBVersion(ctx)
	if err != nil {
		return errors.New("read migration version")
	}
	if err := migrator.stageChecksums(ctx); err != nil {
		return err
	}
	if err := migrator.verifyChecksums(ctx, currentVersion); err != nil {
		return err
	}
	if _, err := migrator.provider.Up(ctx); err != nil {
		return errors.New("apply database migrations")
	}
	currentVersion, err = migrator.provider.GetDBVersion(ctx)
	if err != nil {
		return errors.New("read applied migration version")
	}
	return migrator.verifyChecksums(ctx, currentVersion)
}

func (migrator *Migrator) CurrentVersion(ctx context.Context) (int64, error) {
	version, err := migrator.provider.GetDBVersion(ctx)
	if err != nil {
		return 0, errors.New("read migration version")
	}
	if err := migrator.verifyChecksums(ctx, version); err != nil {
		return 0, err
	}
	return version, nil
}

func collectChecksums(provider *goose.Provider, migrations fs.FS) ([]migrationChecksum, error) {
	sources := provider.ListSources()
	checksums := make([]migrationChecksum, 0, len(sources))
	for _, source := range sources {
		content, err := fs.ReadFile(migrations, source.Path)
		if err != nil {
			return nil, errors.New("read migration source")
		}
		digest := sha256.Sum256(content)
		checksums = append(checksums, migrationChecksum{
			Version:  source.Version,
			Path:     source.Path,
			Checksum: fmt.Sprintf("sha256:%x", digest),
		})
	}
	return checksums, nil
}

func (migrator *Migrator) checksumTableExists(ctx context.Context) (bool, error) {
	var exists bool
	err := migrator.database.QueryRowContext(
		ctx,
		"SELECT to_regclass('notes_goose_checksums') IS NOT NULL",
	).Scan(&exists)
	if err != nil {
		return false, errors.New("inspect migration checksums")
	}
	return exists, nil
}

func (migrator *Migrator) verifyChecksums(ctx context.Context, currentVersion int64) error {
	exists, err := migrator.checksumTableExists(ctx)
	if err != nil {
		return err
	}
	if !exists {
		if currentVersion == 0 {
			return nil
		}
		return ErrMigrationDrift
	}
	rows, err := migrator.database.QueryContext(
		ctx,
		"SELECT version_id, source_path, checksum FROM notes_goose_checksums ORDER BY version_id",
	)
	if err != nil {
		return errors.New("read migration checksums")
	}
	defer rows.Close()
	stored := make(map[int64]migrationChecksum)
	for rows.Next() {
		var checksum migrationChecksum
		if err := rows.Scan(&checksum.Version, &checksum.Path, &checksum.Checksum); err != nil {
			return errors.New("decode migration checksum")
		}
		stored[checksum.Version] = checksum
	}
	if err := rows.Err(); err != nil {
		return errors.New("read migration checksums")
	}
	for _, expected := range migrator.checksums {
		actual, ok := stored[expected.Version]
		if !ok && expected.Version > currentVersion {
			continue
		}
		if !ok || actual.Path != expected.Path || actual.Checksum != expected.Checksum {
			return ErrMigrationDrift
		}
		delete(stored, expected.Version)
	}
	if len(stored) != 0 {
		return ErrMigrationDrift
	}
	return nil
}

func (migrator *Migrator) ensureChecksumTable(ctx context.Context) error {
	_, err := migrator.database.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS notes_goose_checksums (
      version_id bigint PRIMARY KEY CHECK (version_id > 0),
      source_path text NOT NULL UNIQUE,
      checksum text NOT NULL CHECK (checksum ~ '^sha256:[0-9a-f]{64}$')
    )`)
	if err != nil {
		return errors.New("initialize migration checksum ledger")
	}
	return nil
}

func (migrator *Migrator) stageChecksums(ctx context.Context) error {
	transaction, err := migrator.database.BeginTx(ctx, nil)
	if err != nil {
		return errors.New("start checksum transaction")
	}
	defer func() { _ = transaction.Rollback() }()
	for _, checksum := range migrator.checksums {
		if _, err := transaction.ExecContext(
			ctx,
			`INSERT INTO notes_goose_checksums(version_id, source_path, checksum)
             VALUES ($1, $2, $3) ON CONFLICT (version_id) DO NOTHING`,
			checksum.Version,
			checksum.Path,
			checksum.Checksum,
		); err != nil {
			return errors.New("record migration checksum")
		}
	}
	if err := transaction.Commit(); err != nil {
		return errors.New("commit migration checksums")
	}
	return nil
}
