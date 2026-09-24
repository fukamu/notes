package main

import (
	"fmt"
	"io"
	"os"

	"github.com/fukamu/notes/backend/internal/config"
)

func main() {
	os.Exit(run(os.Args[1:], os.Stdout, os.Stderr))
}

func run(arguments []string, stdout io.Writer, stderr io.Writer) int {
	if len(arguments) != 2 || arguments[0] != "config" || arguments[1] != "check" {
		_, _ = fmt.Fprintln(stderr, "usage: notesctl config check")
		return 2
	}
	if _, err := config.Load(os.LookupEnv); err != nil {
		_, _ = fmt.Fprintln(stderr, "configuration invalid")
		return 1
	}
	_, _ = fmt.Fprintln(stdout, "configuration valid")
	return 0
}
