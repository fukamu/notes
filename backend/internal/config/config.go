package config

import (
	"fmt"
	"log/slog"
	"net"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

const (
	defaultBodyLimit       = 4_000_000
	defaultShutdownTimeout = 10 * time.Second
)

type Environment string

const (
	EnvironmentLocal      Environment = "local"
	EnvironmentTest       Environment = "test"
	EnvironmentProduction Environment = "production"
)

type Config struct {
	Environment     Environment
	HTTPAddress     string
	StaticDirectory string
	BodyLimit       int64
	ShutdownTimeout time.Duration
	LogLevel        slog.Level
}

type Error struct {
	Key    string
	Reason string
}

func (e *Error) Error() string {
	return fmt.Sprintf("%s: %s", e.Key, e.Reason)
}

func Load(lookup func(string) (string, bool)) (Config, error) {
	values := make(map[string]string)
	for _, key := range []string{
		"NOTES_ENVIRONMENT",
		"NOTES_HTTP_ADDR",
		"NOTES_STATIC_DIR",
		"NOTES_BODY_LIMIT_BYTES",
		"NOTES_SHUTDOWN_TIMEOUT",
		"NOTES_LOG_LEVEL",
	} {
		if value, ok := lookup(key); ok {
			values[key] = value
		}
	}
	return Parse(values)
}

func Parse(values map[string]string) (Config, error) {
	environmentValue, err := required(values, "NOTES_ENVIRONMENT")
	if err != nil {
		return Config{}, err
	}
	environment, err := parseEnvironment(environmentValue)
	if err != nil {
		return Config{}, err
	}

	address, err := required(values, "NOTES_HTTP_ADDR")
	if err != nil {
		return Config{}, err
	}
	if err := validateAddress(address); err != nil {
		return Config{}, err
	}

	staticDirectory, err := required(values, "NOTES_STATIC_DIR")
	if err != nil {
		return Config{}, err
	}
	if !filepath.IsAbs(staticDirectory) {
		return Config{}, invalid("NOTES_STATIC_DIR", "must be an absolute path")
	}

	bodyLimit, err := optionalPositiveInt(
		values,
		"NOTES_BODY_LIMIT_BYTES",
		defaultBodyLimit,
		4_000_000,
	)
	if err != nil {
		return Config{}, err
	}

	shutdownTimeout, err := optionalDuration(
		values,
		"NOTES_SHUTDOWN_TIMEOUT",
		defaultShutdownTimeout,
	)
	if err != nil {
		return Config{}, err
	}

	logLevel, err := optionalLogLevel(values)
	if err != nil {
		return Config{}, err
	}

	return Config{
		Environment:     environment,
		HTTPAddress:     address,
		StaticDirectory: filepath.Clean(staticDirectory),
		BodyLimit:       bodyLimit,
		ShutdownTimeout: shutdownTimeout,
		LogLevel:        logLevel,
	}, nil
}

func required(values map[string]string, key string) (string, error) {
	value, ok := values[key]
	if !ok || strings.TrimSpace(value) == "" {
		return "", invalid(key, "is required")
	}
	return value, nil
}

func parseEnvironment(value string) (Environment, error) {
	switch Environment(value) {
	case EnvironmentLocal, EnvironmentTest, EnvironmentProduction:
		return Environment(value), nil
	default:
		return "", invalid("NOTES_ENVIRONMENT", "must be local, test, or production")
	}
}

func validateAddress(value string) error {
	host, portValue, err := net.SplitHostPort(value)
	if err != nil || strings.TrimSpace(host) == "" {
		return invalid("NOTES_HTTP_ADDR", "must contain an explicit host and port")
	}
	port, err := strconv.Atoi(portValue)
	if err != nil || port < 1 || port > 65_535 {
		return invalid("NOTES_HTTP_ADDR", "must contain a port from 1 to 65535")
	}
	return nil
}

func optionalPositiveInt(
	values map[string]string,
	key string,
	fallback int64,
	maximum int64,
) (int64, error) {
	value, ok := values[key]
	if !ok {
		return fallback, nil
	}
	if strings.TrimSpace(value) == "" {
		return 0, invalid(key, "must not be empty")
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil || parsed < 1 || parsed > maximum {
		return 0, invalid(key, fmt.Sprintf("must be an integer from 1 to %d", maximum))
	}
	return parsed, nil
}

func optionalDuration(
	values map[string]string,
	key string,
	fallback time.Duration,
) (time.Duration, error) {
	value, ok := values[key]
	if !ok {
		return fallback, nil
	}
	if strings.TrimSpace(value) == "" {
		return 0, invalid(key, "must not be empty")
	}
	parsed, err := time.ParseDuration(value)
	if err != nil || parsed < time.Second || parsed > time.Minute {
		return 0, invalid(key, "must be a duration from 1s to 1m")
	}
	return parsed, nil
}

func optionalLogLevel(values map[string]string) (slog.Level, error) {
	value, ok := values["NOTES_LOG_LEVEL"]
	if !ok {
		return slog.LevelInfo, nil
	}
	switch value {
	case "debug":
		return slog.LevelDebug, nil
	case "info":
		return slog.LevelInfo, nil
	case "warn":
		return slog.LevelWarn, nil
	case "error":
		return slog.LevelError, nil
	default:
		return 0, invalid(
			"NOTES_LOG_LEVEL",
			"must be debug, info, warn, or error",
		)
	}
}

func invalid(key string, reason string) error {
	return &Error{Key: key, Reason: reason}
}
