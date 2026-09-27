package postgres_test

import (
	"strings"
	"testing"

	postgresadapter "github.com/fukamu/notes/backend/internal/adapters/postgres"
)

func TestValidateTestDatabaseURL(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name    string
		url     string
		wantErr bool
	}{
		{name: "localhost", url: "postgres://notes:secret@localhost:5432/fukamu_notes_go_test"},
		{name: "loopback", url: "postgres://notes:secret@127.0.0.1:5432/fukamu_notes_go_test"},
		{name: "wrong host", url: "postgres://notes:secret@db.example/fukamu_notes_go_test", wantErr: true},
		{name: "wrong database", url: "postgres://notes:secret@localhost/notes", wantErr: true},
		{name: "host override", url: "postgres://notes:secret@localhost/fukamu_notes_go_test?hostaddr=203.0.113.10", wantErr: true},
		{name: "database override", url: "postgres://notes:secret@localhost/fukamu_notes_go_test?database=production", wantErr: true},
		{name: "service file", url: "postgres://notes:secret@localhost/fukamu_notes_go_test?servicefile=/tmp/pg-service.conf", wantErr: true},
		{name: "duplicate ssl mode", url: "postgres://notes:secret@localhost/fukamu_notes_go_test?sslmode=disable&sslmode=require", wantErr: true},
		{name: "wrong scheme", url: "mysql://notes:secret@localhost/fukamu_notes_go_test", wantErr: true},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			err := postgresadapter.ValidateTestDatabaseURL(test.url)
			if (err != nil) != test.wantErr {
				t.Fatalf("error = %v", err)
			}
			if err != nil && strings.Contains(err.Error(), "secret") {
				t.Fatal("validation error disclosed credentials")
			}
		})
	}
}

func TestValidateProductionDatabaseTarget(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name     string
		url      string
		host     string
		database string
		wantErr  bool
	}{
		{
			name: "exact TLS target", url: "postgres://notes:secret@db.example:5432/notes?sslmode=require",
			host: "db.example", database: "notes",
		},
		{
			name: "verified TLS target", url: "postgresql://notes@192.0.2.10/notes?sslmode=verify-full",
			host: "192.0.2.10", database: "notes",
		},
		{
			name: "host mismatch", url: "postgres://notes:secret@other.example/notes?sslmode=require",
			host: "db.example", database: "notes", wantErr: true,
		},
		{
			name: "database mismatch", url: "postgres://notes:secret@db.example/other?sslmode=require",
			host: "db.example", database: "notes", wantErr: true,
		},
		{
			name: "TLS disabled", url: "postgres://notes:secret@db.example/notes?sslmode=disable",
			host: "db.example", database: "notes", wantErr: true,
		},
		{
			name: "host override", url: "postgres://notes:secret@db.example/notes?sslmode=require&host=other.example",
			host: "db.example", database: "notes", wantErr: true,
		},
		{
			name: "service file", url: "postgres://notes:secret@db.example/notes?sslmode=require&servicefile=/tmp/pg.conf",
			host: "db.example", database: "notes", wantErr: true,
		},
		{
			name: "duplicate mode", url: "postgres://notes:secret@db.example/notes?sslmode=require&sslmode=verify-full",
			host: "db.example", database: "notes", wantErr: true,
		},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			err := postgresadapter.ValidateProductionDatabaseTarget(test.url, test.host, test.database)
			if (err != nil) != test.wantErr {
				t.Fatalf("error = %v", err)
			}
			if err != nil && strings.Contains(err.Error(), "secret") {
				t.Fatal("validation error disclosed credentials")
			}
		})
	}
}
