package telemetry

import (
	"io"
	"log/slog"
	"strings"
	"unicode"
)

const redactedValue = "[REDACTED]"

func NewLogger(output io.Writer, level slog.Leveler) *slog.Logger {
	handler := slog.NewJSONHandler(output, &slog.HandlerOptions{
		Level:       level,
		ReplaceAttr: redactAttribute,
	})
	return slog.New(handler)
}

func redactAttribute(_ []string, attribute slog.Attr) slog.Attr {
	if sensitiveKey(attribute.Key) {
		return slog.String(attribute.Key, redactedValue)
	}
	return attribute
}

func sensitiveKey(key string) bool {
	normalized := strings.Map(func(value rune) rune {
		if unicode.IsLetter(value) || unicode.IsDigit(value) {
			return unicode.ToLower(value)
		}
		return -1
	}, key)
	for _, marker := range []string{
		"authorization",
		"cookie",
		"token",
		"secret",
		"password",
		"apikey",
		"privatekey",
		"requestbody",
		"responsebody",
		"query",
	} {
		if strings.Contains(normalized, marker) {
			return true
		}
	}
	return false
}
