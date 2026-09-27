package postgres

import "testing"

func TestValidLocalFixtureLaunchConfigRequiresExactClosedMigrationState(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name                string
		singleton           int16
		publicAccessEnabled bool
		updatedAt           int64
		count               int64
		want                bool
	}{
		{name: "exact closed singleton", singleton: 1, updatedAt: 0, count: 1, want: true},
		{name: "deleted", singleton: 1, updatedAt: 0, count: 0},
		{name: "duplicate", singleton: 1, updatedAt: 0, count: 2},
		{name: "wrong singleton", singleton: 2, updatedAt: 0, count: 1},
		{name: "public access enabled", singleton: 1, publicAccessEnabled: true, updatedAt: 0, count: 1},
		{name: "mutated timestamp", singleton: 1, updatedAt: 1, count: 1},
	}

	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if got := validLocalFixtureLaunchConfig(
				test.singleton,
				test.publicAccessEnabled,
				test.updatedAt,
				test.count,
			); got != test.want {
				t.Fatalf("validLocalFixtureLaunchConfig() = %t, want %t", got, test.want)
			}
		})
	}
}
