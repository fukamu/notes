package config

import (
	"crypto/ed25519"
	"encoding/base64"
	"fmt"
	"log/slog"
	"net"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/fukamu/notes/backend/internal/access"
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
	PrivateRuntime  *PrivateRuntimeConfig
}

type PrivateRuntimeConfig struct {
	DatabaseURL        string
	MaximumConnections int32
	PublicOrigin       *url.URL
	Issuer             string
	Audience           string
	PublicKey          ed25519.PublicKey
	LegacyOwner        access.Subject
}

type DatabaseConfig struct {
	Environment Environment
	URL         string
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
		"NOTES_PRIVATE_AUTH_MODE",
		"NOTES_DATABASE_URL",
		"NOTES_DATABASE_MAX_CONNECTIONS",
		"NOTES_PUBLIC_ORIGIN",
		"NOTES_LOCAL_AUTH_ISSUER",
		"NOTES_LOCAL_AUTH_AUDIENCE",
		"NOTES_LOCAL_AUTH_PUBLIC_KEY",
		"NOTES_LEGACY_OWNER_SUBJECT",
	} {
		if value, ok := lookup(key); ok {
			values[key] = value
		}
	}
	return Parse(values)
}

func LoadDatabase(lookup func(string) (string, bool)) (DatabaseConfig, error) {
	values := make(map[string]string)
	for _, key := range []string{"NOTES_ENVIRONMENT", "NOTES_DATABASE_URL"} {
		if value, ok := lookup(key); ok {
			values[key] = value
		}
	}
	return ParseDatabase(values)
}

func ParseDatabase(values map[string]string) (DatabaseConfig, error) {
	environmentValue, err := required(values, "NOTES_ENVIRONMENT")
	if err != nil {
		return DatabaseConfig{}, err
	}
	environment, err := parseEnvironment(environmentValue)
	if err != nil {
		return DatabaseConfig{}, err
	}
	databaseURL, err := required(values, "NOTES_DATABASE_URL")
	if err != nil {
		return DatabaseConfig{}, err
	}
	if strings.ContainsAny(databaseURL, "\r\n\x00") {
		return DatabaseConfig{}, invalid("NOTES_DATABASE_URL", "contains invalid control characters")
	}
	return DatabaseConfig{Environment: environment, URL: databaseURL}, nil
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
	privateRuntime, err := parsePrivateRuntime(values, environment)
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
		PrivateRuntime:  privateRuntime,
	}, nil
}

func parsePrivateRuntime(
	values map[string]string,
	environment Environment,
) (*PrivateRuntimeConfig, error) {
	mode := values["NOTES_PRIVATE_AUTH_MODE"]
	if mode == "" || mode == "disabled" {
		return nil, nil
	}
	if mode != "local-signed" {
		return nil, invalid("NOTES_PRIVATE_AUTH_MODE", "must be disabled or local-signed")
	}
	if environment == EnvironmentProduction {
		return nil, invalid("NOTES_PRIVATE_AUTH_MODE", "local-signed is unavailable in production")
	}
	databaseURL, err := required(values, "NOTES_DATABASE_URL")
	if err != nil {
		return nil, err
	}
	if strings.ContainsAny(databaseURL, "\r\n\x00") {
		return nil, invalid("NOTES_DATABASE_URL", "contains invalid control characters")
	}
	maximumConnections, err := optionalPositiveInt(
		values,
		"NOTES_DATABASE_MAX_CONNECTIONS",
		4,
		32,
	)
	if err != nil {
		return nil, err
	}
	publicOriginValue, err := required(values, "NOTES_PUBLIC_ORIGIN")
	if err != nil {
		return nil, err
	}
	publicOrigin, err := parsePublicOrigin(publicOriginValue, environment)
	if err != nil {
		return nil, err
	}
	issuer, err := required(values, "NOTES_LOCAL_AUTH_ISSUER")
	if err != nil {
		return nil, err
	}
	if err := validateIssuer(issuer); err != nil {
		return nil, err
	}
	audience, err := required(values, "NOTES_LOCAL_AUTH_AUDIENCE")
	if err != nil {
		return nil, err
	}
	if _, err := access.ParseSubject(audience); err != nil {
		return nil, invalid("NOTES_LOCAL_AUTH_AUDIENCE", "must be a bounded opaque value")
	}
	publicKeyValue, err := required(values, "NOTES_LOCAL_AUTH_PUBLIC_KEY")
	if err != nil {
		return nil, err
	}
	publicKey, err := base64.RawURLEncoding.DecodeString(publicKeyValue)
	if err != nil || len(publicKey) != ed25519.PublicKeySize ||
		base64.RawURLEncoding.EncodeToString(publicKey) != publicKeyValue {
		return nil, invalid("NOTES_LOCAL_AUTH_PUBLIC_KEY", "must be a canonical Ed25519 public key")
	}
	ownerValue, err := required(values, "NOTES_LEGACY_OWNER_SUBJECT")
	if err != nil {
		return nil, err
	}
	owner, err := access.ParseSubject(ownerValue)
	if err != nil {
		return nil, invalid("NOTES_LEGACY_OWNER_SUBJECT", "must be a bounded opaque value")
	}
	return &PrivateRuntimeConfig{
		DatabaseURL:        databaseURL,
		MaximumConnections: int32(maximumConnections),
		PublicOrigin:       publicOrigin,
		Issuer:             issuer,
		Audience:           audience,
		PublicKey:          append(ed25519.PublicKey(nil), publicKey...),
		LegacyOwner:        owner,
	}, nil
}

func parsePublicOrigin(value string, environment Environment) (*url.URL, error) {
	parsed, err := url.Parse(value)
	if err != nil || parsed.Host == "" || parsed.User != nil ||
		(parsed.Path != "" && parsed.Path != "/") || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, invalid("NOTES_PUBLIC_ORIGIN", "must be an absolute origin")
	}
	if parsed.Scheme == "https" {
		parsed.Path = ""
		return parsed, nil
	}
	loopback := parsed.Hostname() == "localhost" || parsed.Hostname() == "127.0.0.1" || parsed.Hostname() == "::1"
	if parsed.Scheme != "http" || !loopback || environment == EnvironmentProduction {
		return nil, invalid("NOTES_PUBLIC_ORIGIN", "must use HTTPS or local loopback HTTP")
	}
	parsed.Path = ""
	return parsed, nil
}

func validateIssuer(value string) error {
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil ||
		parsed.RawQuery != "" || parsed.Fragment != "" {
		return invalid("NOTES_LOCAL_AUTH_ISSUER", "must be an absolute HTTPS issuer")
	}
	return nil
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
