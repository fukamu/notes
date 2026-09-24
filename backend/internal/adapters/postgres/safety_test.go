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
