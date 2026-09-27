package postgres

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5/pgxpool"
)

type SchemaReadiness struct {
	pool            *pgxpool.Pool
	expectedVersion int64
}

func NewSchemaReadiness(pool *pgxpool.Pool, expectedVersion int64) (*SchemaReadiness, error) {
	if pool == nil || expectedVersion < 1 {
		return nil, errors.New("database pool and positive schema version are required")
	}
	return &SchemaReadiness{pool: pool, expectedVersion: expectedVersion}, nil
}

func (readiness *SchemaReadiness) Check(ctx context.Context) error {
	if readiness == nil || readiness.pool == nil {
		return ErrDatabaseUnavailable
	}
	var version int64
	err := readiness.pool.QueryRow(
		ctx,
		`SELECT versions.version_id
         FROM (
           SELECT version_id FROM notes_goose_versions
           WHERE is_applied ORDER BY id DESC LIMIT 1
         ) AS versions
         CROSS JOIN launch_config
         WHERE launch_config.singleton = 1`,
	).Scan(&version)
	if err != nil || version != readiness.expectedVersion {
		return ErrDatabaseUnavailable
	}
	return nil
}
