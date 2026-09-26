package main

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	accessadapter "github.com/fukamu/notes/backend/internal/adapters/access"
	accountdeletioncredentialadapter "github.com/fukamu/notes/backend/internal/adapters/accountdeletioncredential"
	contentcryptoadapter "github.com/fukamu/notes/backend/internal/adapters/contentcrypto"
	legalhashadapter "github.com/fukamu/notes/backend/internal/adapters/legalhash"
	localcommerceadapter "github.com/fukamu/notes/backend/internal/adapters/localcommerce"
	localfixtureadapter "github.com/fukamu/notes/backend/internal/adapters/localfixture"
	objectstorageadapter "github.com/fukamu/notes/backend/internal/adapters/objectstorage"
	otpadapter "github.com/fukamu/notes/backend/internal/adapters/otp"
	postgresadapter "github.com/fukamu/notes/backend/internal/adapters/postgres"
	recoverykeyadapter "github.com/fukamu/notes/backend/internal/adapters/recoverykey"
	"github.com/fukamu/notes/backend/internal/billing"
	"github.com/fukamu/notes/backend/internal/config"
	"github.com/fukamu/notes/backend/internal/cryptocontent"
	"github.com/fukamu/notes/backend/internal/entitlement"
	"github.com/fukamu/notes/backend/internal/httpapi"
	"github.com/fukamu/notes/backend/internal/legal"
	"github.com/fukamu/notes/backend/internal/localfixture"
	"github.com/fukamu/notes/backend/internal/runtimefoundation"
	"github.com/fukamu/notes/backend/internal/syncv2"
	"github.com/fukamu/notes/backend/internal/telemetry"
	"github.com/fukamu/notes/backend/migrations"
)

func main() {
	os.Exit(run())
}

func run() int {
	bootstrapLogger := telemetry.NewLogger(os.Stderr, slog.LevelInfo)
	configuration, err := config.Load(os.LookupEnv)
	if err != nil {
		bootstrapLogger.Error(
			"configuration rejected",
			"error_code",
			"invalid_configuration",
		)
		return 1
	}
	logger := telemetry.NewLogger(os.Stderr, configuration.LogLevel)
	ctx, stop := signal.NotifyContext(
		context.Background(),
		os.Interrupt,
		syscall.SIGTERM,
	)
	defer stop()
	runtime, closeRuntime, err := composeRuntime(ctx, configuration)
	if err != nil {
		logger.Error("runtime unavailable", "error_code", "runtime_failure")
		return 1
	}
	defer closeRuntime()

	logger.Info(
		"server starting",
		"environment", string(configuration.Environment),
		"address", configuration.HTTPAddress,
		"application_profile", string(configuration.ApplicationProfile),
	)
	if err := httpapi.Run(ctx, httpapi.ServerOptions{
		Address:                    configuration.HTTPAddress,
		StaticDirectory:            configuration.StaticDirectory,
		BodyLimit:                  configuration.BodyLimit,
		ShutdownTimeout:            configuration.ShutdownTimeout,
		Logger:                     logger,
		PrivateRuntime:             runtime.private,
		SyncV2Runtime:              runtime.syncV2,
		LegalRuntime:               runtime.legal,
		BillingCancellationRuntime: runtime.billingCancellation,
		EnableDisconnectedFixtures: disconnectedFixturesEnabled(configuration.Environment),
	}); err != nil {
		logger.Error("server stopped", "error_code", "server_failure")
		return 1
	}
	logger.Info("server stopped", "reason", "shutdown")
	return 0
}

type runtimeComposition struct {
	private             *httpapi.PrivateRuntime
	legal               *httpapi.LegalRuntime
	billingCancellation *httpapi.BillingCancellationRuntime
	localFixture        *runtimefoundation.LocalFixture
	syncV2              *httpapi.SyncV2Runtime
	syncV2Application   *syncv2.Application
}

func disconnectedFixturesEnabled(environment config.Environment) bool {
	return environment != config.EnvironmentProduction
}

func composeRuntime(
	ctx context.Context,
	configuration config.Config,
) (runtimeComposition, func(), error) {
	if err := validateRuntimeConfiguration(configuration); err != nil {
		return runtimeComposition{}, func() {}, err
	}
	if configuration.PrivateRuntime == nil {
		return runtimeComposition{}, func() {}, nil
	}
	settings := configuration.PrivateRuntime
	verifier, err := accessadapter.NewLocalVerifier(
		settings.PublicKey,
		settings.Issuer,
		settings.Audience,
	)
	if err != nil {
		return runtimeComposition{}, func() {}, errors.New("configure private identity verifier")
	}
	var fixtureLayout localfixtureadapter.Layout
	var fixtureMetadataReady bool
	if configuration.LocalFixture != nil {
		fixtureLayout, err = localfixtureadapter.OpenLayout(configuration.LocalFixture.PrivateRoot)
		if err != nil {
			return runtimeComposition{}, func() {}, errors.New("open local fixture directories")
		}
		if _, err := recoverykeyadapter.LoadFixtureMetadata(
			fixtureLayout.KeyDirectory,
			configuration.LocalFixture.VaultID,
		); err != nil {
			return runtimeComposition{}, func() {}, errors.New("load local fixture key")
		}
		fixtureMetadataReady = true
	}
	startupContext, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	pool, err := postgresadapter.OpenPool(
		startupContext,
		settings.DatabaseURL,
		settings.MaximumConnections,
	)
	if err != nil {
		return runtimeComposition{}, func() {}, errors.New("open private database")
	}
	closeRuntime := func() { pool.Close() }
	gate, err := postgresadapter.NewLaunchGateReader(pool)
	if err != nil {
		closeRuntime()
		return runtimeComposition{}, func() {}, errors.New("configure launch gate")
	}
	schemaReadiness, err := postgresadapter.NewSchemaReadiness(pool, migrations.LatestVersion)
	if err != nil {
		closeRuntime()
		return runtimeComposition{}, func() {}, errors.New("configure database readiness")
	}
	legacySync, err := postgresadapter.NewLegacySyncStore(pool)
	if err != nil {
		closeRuntime()
		return runtimeComposition{}, func() {}, errors.New("configure legacy sync")
	}
	readiness := runtimefoundation.Readiness(schemaReadiness)
	composition := runtimeComposition{}
	if configuration.LocalFixture != nil {
		if !fixtureMetadataReady {
			closeRuntime()
			return runtimeComposition{}, func() {}, errors.New("local fixture key unavailable")
		}
		fixtureConfig := configuration.LocalFixture
		metadata, metadataErr := recoverykeyadapter.LoadFixtureMetadata(
			fixtureLayout.KeyDirectory,
			fixtureConfig.VaultID,
		)
		if metadataErr != nil {
			closeRuntime()
			return runtimeComposition{}, func() {}, errors.New("load local fixture key")
		}
		seed, seedErr := localfixture.NewSeed(
			fixtureConfig.AllowedSubject,
			fixtureConfig.AccountID,
			fixtureConfig.VaultID,
			fixtureConfig.SessionID,
			fixtureConfig.SessionEpoch,
			fixtureConfig.SessionToken,
			metadata,
		)
		if seedErr != nil {
			closeRuntime()
			return runtimeComposition{}, func() {}, errors.New("configure local fixture seed")
		}
		fixtureStore, storeErr := postgresadapter.NewLocalFixtureStore(pool, seed)
		if storeErr != nil {
			closeRuntime()
			return runtimeComposition{}, func() {}, errors.New("configure local fixture database")
		}
		sessionStore, sessionErr := postgresadapter.NewSessionStore(pool)
		if sessionErr != nil {
			closeRuntime()
			return runtimeComposition{}, func() {}, errors.New("configure local fixture sessions")
		}
		sessionResolver, resolverErr := postgresadapter.NewSessionResolver(sessionStore)
		if resolverErr != nil {
			closeRuntime()
			return runtimeComposition{}, func() {}, errors.New("configure local fixture sessions")
		}
		scopedSessions, scopedSessionErr := runtimefoundation.NewScopedSessionResolver(
			seed.Context,
			sessionResolver,
		)
		if scopedSessionErr != nil {
			closeRuntime()
			return runtimeComposition{}, func() {}, errors.New("scope local fixture sessions")
		}
		objects, objectErr := objectstorageadapter.NewDirectory(fixtureLayout.ObjectDirectory)
		if objectErr != nil {
			closeRuntime()
			return runtimeComposition{}, func() {}, errors.New("configure local fixture object storage")
		}
		nonces, nonceErr := contentcryptoadapter.NewDirectoryNonceReservations(fixtureLayout.NonceDirectory)
		if nonceErr != nil {
			closeRuntime()
			return runtimeComposition{}, func() {}, errors.New("configure local fixture nonce reservations")
		}
		keys, keyErr := recoverykeyadapter.NewDirectory(fixtureLayout.KeyDirectory, fixtureConfig.VaultID)
		if keyErr != nil {
			closeRuntime()
			return runtimeComposition{}, func() {}, errors.New("configure local fixture key management")
		}
		cursors, cursorErr := syncv2.NewCursorAuthenticator(fixtureConfig.CursorHMACKey[:])
		if cursorErr != nil {
			closeRuntime()
			return runtimeComposition{}, func() {}, errors.New("configure local fixture cursor authentication")
		}
		deletionCredentials, deletionErr := accountdeletioncredentialadapter.New(
			fixtureConfig.DeletionHMACKey[:],
		)
		if deletionErr != nil {
			closeRuntime()
			return runtimeComposition{}, func() {}, errors.New("configure local fixture deletion credentials")
		}
		directoryReadiness, directoryErr := localfixtureadapter.NewReadiness(
			fixtureConfig.PrivateRoot,
			fixtureConfig.VaultID,
		)
		if directoryErr != nil {
			closeRuntime()
			return runtimeComposition{}, func() {}, errors.New("configure local fixture directory readiness")
		}
		aggregate, aggregateErr := runtimefoundation.NewAggregateReadiness(
			schemaReadiness,
			fixtureStore,
			directoryReadiness,
		)
		if aggregateErr != nil || aggregate.Check(startupContext) != nil {
			closeRuntime()
			return runtimeComposition{}, func() {}, errors.New("local fixture is not ready")
		}
		foundation, foundationErr := runtimefoundation.NewLocalFixture(
			runtimefoundation.LocalFixtureOptions{
				Context: seed.Context, Sessions: scopedSessions, Objects: objects,
				NonceReservations: nonces, Keys: keys, Cursors: cursors,
				DeletionCredentials: deletionCredentials,
			},
		)
		if foundationErr != nil {
			closeRuntime()
			return runtimeComposition{}, func() {}, errors.New("configure local fixture foundation")
		}
		composition.localFixture = foundation
		termsStore, termsStoreErr := postgresadapter.NewTermsConsentStore(pool)
		if termsStoreErr != nil {
			closeRuntime()
			return runtimeComposition{}, func() {}, errors.New("configure local fixture terms store")
		}
		termsService, termsErr := legal.NewTermsConsentService(
			localcommerceadapter.TermsSource{}, legalhashadapter.SHA256Hasher{}, termsStore,
		)
		if termsErr != nil {
			closeRuntime()
			return runtimeComposition{}, func() {}, errors.New("configure local fixture terms")
		}
		evidenceStore, evidenceStoreErr := postgresadapter.NewContractEvidenceStore(pool)
		if evidenceStoreErr != nil {
			closeRuntime()
			return runtimeComposition{}, func() {}, errors.New("configure local fixture contract evidence")
		}
		evidenceService, evidenceErr := legal.NewContractEvidenceService(
			evidenceStore, legalhashadapter.OfferSHA256Hasher{},
		)
		if evidenceErr != nil {
			closeRuntime()
			return runtimeComposition{}, func() {}, errors.New("configure local fixture contract evidence")
		}
		billingStore, billingStoreErr := postgresadapter.NewBillingStore(pool)
		if billingStoreErr != nil {
			closeRuntime()
			return runtimeComposition{}, func() {}, errors.New("configure local fixture billing")
		}
		entitlementStore, entitlementStoreErr := postgresadapter.NewEntitlementStore(pool)
		if entitlementStoreErr != nil {
			closeRuntime()
			return runtimeComposition{}, func() {}, errors.New("configure local fixture entitlement")
		}
		billingService, billingServiceErr := billing.NewService(entitlementStore, billingStore)
		if billingServiceErr != nil {
			closeRuntime()
			return runtimeComposition{}, func() {}, errors.New("configure local fixture billing")
		}
		entitlementService, entitlementServiceErr := entitlement.NewService(
			billingService,
			entitlementStore,
			entitlementStore,
			entitlement.FukamuOfflineLeasePolicy(),
		)
		if entitlementServiceErr != nil {
			closeRuntime()
			return runtimeComposition{}, func() {}, errors.New("configure local fixture entitlement")
		}
		scopedEntitlement, scopedEntitlementErr := runtimefoundation.NewScopedEntitlement(
			seed.Context,
			localfixture.FixtureTimestamp,
			entitlementService,
		)
		if scopedEntitlementErr != nil {
			closeRuntime()
			return runtimeComposition{}, func() {}, errors.New("scope local fixture entitlement")
		}
		commerceProvider, providerErr := localcommerceadapter.NewProvider(
			seed, billingStore, entitlementStore,
		)
		if providerErr != nil {
			closeRuntime()
			return runtimeComposition{}, func() {}, errors.New("configure local fixture commerce provider")
		}
		checkout, checkoutErr := legal.NewContractCheckoutApplication(
			evidenceService, localcommerceadapter.OfferSource{}, termsService, commerceProvider,
		)
		if checkoutErr != nil {
			closeRuntime()
			return runtimeComposition{}, func() {}, errors.New("configure local fixture checkout")
		}
		cancellation, cancellationErr := billing.NewCancellationService(billingStore, commerceProvider)
		if cancellationErr != nil {
			closeRuntime()
			return runtimeComposition{}, func() {}, errors.New("configure local fixture cancellation")
		}
		journalDirectory, journalErr := postgresadapter.NewSyncV2JournalDirectory(pool)
		if journalErr != nil {
			closeRuntime()
			return runtimeComposition{}, func() {}, errors.New("configure local fixture Sync v2 journal")
		}
		metadataDirectory, metadataErr := postgresadapter.NewSyncV2MetadataDirectory(pool)
		if metadataErr != nil {
			closeRuntime()
			return runtimeComposition{}, func() {}, errors.New("configure local fixture encrypted metadata")
		}
		quotaDirectory, quotaErr := postgresadapter.NewQuotaLedgerDirectory(pool)
		if quotaErr != nil {
			closeRuntime()
			return runtimeComposition{}, func() {}, errors.New("configure local fixture quota")
		}
		keyrings, keyringErr := postgresadapter.NewVaultDEKStore(pool)
		if keyringErr != nil {
			closeRuntime()
			return runtimeComposition{}, func() {}, errors.New("configure local fixture keyring")
		}
		encryption, encryptionErr := cryptocontent.NewService(
			keys,
			contentcryptoadapter.NewSecureRandomNonceGenerator(),
			nonces,
			contentcryptoadapter.AES256GCM{},
		)
		if encryptionErr != nil {
			closeRuntime()
			return runtimeComposition{}, func() {}, errors.New("configure local fixture encryption")
		}
		contents, contentsErr := syncv2.NewEncryptedContentDirectory(
			metadataDirectory,
			objects,
			objectstorageadapter.NewRandomObjectKeyGenerator(),
			encryption,
			keyrings,
		)
		if contentsErr != nil {
			closeRuntime()
			return runtimeComposition{}, func() {}, errors.New("configure local fixture encrypted content")
		}
		application, applicationErr := syncv2.NewApplication(
			journalDirectory,
			contents,
			cursors,
			quotaDirectory,
			60_000,
		)
		if applicationErr != nil {
			closeRuntime()
			return runtimeComposition{}, func() {}, errors.New("configure local fixture Sync v2 application")
		}
		identifiers := otpadapter.NewProductionSecrets()
		fixtureClock := func() int64 { return time.Now().UnixMilli() }
		composition.legal = &httpapi.LegalRuntime{
			ExpectedOrigin: fixtureConfig.PublicOrigin.String(), Clock: fixtureClock,
			Sessions: scopedSessions, Terms: termsService, Checkout: checkout,
			NewTermsConsentID:     legalIdentifierGenerator(identifiers),
			NewContractEvidenceID: legalIdentifierGenerator(identifiers),
		}
		composition.billingCancellation = &httpapi.BillingCancellationRuntime{
			ExpectedOrigin: fixtureConfig.PublicOrigin.String(), Clock: fixtureClock,
			Sessions: scopedSessions, Cancellation: cancellation,
		}
		composition.syncV2 = &httpapi.SyncV2Runtime{
			ExpectedOrigin: fixtureConfig.PublicOrigin.String(),
			Clock:          fixtureClock,
			Sessions:       scopedSessions,
			Entitlement:    scopedEntitlement,
			Application:    application,
		}
		composition.syncV2Application = application
		readiness = aggregate
	}
	composition.private = &httpapi.PrivateRuntime{
		Verifier:     verifier,
		Gate:         gate,
		Readiness:    readiness,
		LegacySync:   legacySync,
		LegacyOwner:  settings.LegacyOwner,
		PublicOrigin: settings.PublicOrigin,
		Clock:        time.Now,
	}
	return composition, closeRuntime, nil
}

type legalIdentifierSource interface {
	CreateChallengeID(context.Context) (string, error)
}

func legalIdentifierGenerator(source legalIdentifierSource) func() string {
	return func() string {
		if source == nil {
			return ""
		}
		identifier, err := source.CreateChallengeID(context.Background())
		if err != nil {
			return ""
		}
		return identifier
	}
}

func validateRuntimeConfiguration(configuration config.Config) error {
	switch configuration.ApplicationProfile {
	case "", config.ApplicationProfileDisabled:
		if configuration.LocalFixture != nil {
			return errors.New("disabled application profile contains local fixture configuration")
		}
		return nil
	case config.ApplicationProfileLocalFixture:
	default:
		return errors.New("unknown application profile")
	}
	if configuration.Environment == config.EnvironmentProduction || configuration.PrivateRuntime == nil ||
		configuration.LocalFixture == nil {
		return errors.New("local fixture profile is unavailable")
	}
	private := configuration.PrivateRuntime
	fixture := configuration.LocalFixture
	if fixture.DatabaseURL != private.DatabaseURL || fixture.PublicOrigin == nil || private.PublicOrigin == nil ||
		fixture.PublicOrigin.String() != private.PublicOrigin.String() ||
		fixture.AllowedSubject != private.LegacyOwner ||
		fixture.ObjectDirectory != filepath.Join(fixture.PrivateRoot, localfixture.ObjectDirectoryName) ||
		fixture.NonceDirectory != filepath.Join(fixture.PrivateRoot, localfixture.NonceDirectoryName) ||
		fixture.KeyDirectory != filepath.Join(fixture.PrivateRoot, localfixture.KeyDirectoryName) ||
		localfixture.ValidateDatabaseURL(fixture.DatabaseURL) != nil {
		return errors.New("local fixture profile does not match private runtime")
	}
	return nil
}
