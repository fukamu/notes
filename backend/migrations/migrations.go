package migrations

import "embed"

const LatestVersion int64 = 6

// Files contains the immutable, ordered SQL migrations used by notesctl.
//
//go:embed *.sql
var Files embed.FS
