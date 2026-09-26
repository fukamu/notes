package main

import (
	"context"
	"errors"
	"log/slog"
	"os"
	"os/signal"
	"path/filepath"
	"sync"
	"syscall"
	"time"

	"github.com/fukamu/notes/backend/internal/accountdeletion"
	accessadapter "github.com/fukamu/notes/backend/internal/adapters/access"
	accountdeletioncredentialadapter "github.com/fukamu/notes/backend/internal/adapters/accountdeletioncredential"
	contentcryptoadapter "github.com/fukamu/notes/backend/internal/adapters/contentcrypto"
	legalhashadapter "github.com/fukamu/notes/backend/internal/adapters/legalhash"
	localcommerceadapter "github.com/fukamu/notes/backend/internal/adapters/localcommerce"
	localfixtureadapter "github.com/fukamu/notes/backend/internal/adapters/localfixture"
	objectstorageadapter "github.com/fukamu/notes/backend/internal/adapters/objectstorage"
	otpadapter "github.com/fukamu/notes/backend/internal/adapters/otp"
	postgresadapter "github.com/fukamu/notes/backend/internal/adapters/postgres"
	privacydeletionadapter "github.com/fukamu/notes/backend/internal/adapters/privacydeletion"
	privacyunavailableadapter "github.com/fukamu/notes/backend/internal/adapters/privacyunavailable"
	recoverykeyadapter "github.com/fukamu/notes/backend/internal/adapters/recoverykey"
	"github.com/fukamu/notes/backend/internal/billing"
	"github.com/fukamu/notes/backend/internal/config"
	"github.com/fukamu/notes/backend/internal/cryptocontent"
	"github.com/fukamu/notes/backend/internal/encryptedobject"
	"github.com/fukamu/notes/backend/internal/entitlement"
	"github.com/fukamu/notes/backend/internal/httpapi"
	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/fukamu/notes/backend/internal/legal"
	"github.com/fukamu/notes/backend/internal/localfixture"
	"github.com/fukamu/notes/backend/internal/privacyrequest"
	"github.com/fukamu/notes/backend/internal/runtimefoundation"
	"github.com/fukamu/notes/backend/internal/syncv2"
	"github.com/fukamu/notes/backend/internal/telemetry"
	"github.com/fukamu/notes/backend/internal/vaultdata"
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
		AccountDeletionRuntime:     runtime.accountDeletion,
		PrivacyRequestRuntime:      runtime.privacyRequest,
		DisableLegacySync:          runtime.disableLegacySync,
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
	syncV2Application   *runtimefoundation.LeaseCheckedSyncV2Application
	accountDeletion     *httpapi.AccountDeletionRuntime
	deletionApplication *runtimefoundation.LeaseCheckedAccountDeletionApplication
	deletionEffects     *composedDeletionEffects
	privacyRequest      *httpapi.PrivacyRequestRuntime
	privacyApplication  *privacyrequest.Service
	privacyStore        *postgresadapter.PrivacyRequestStore
	disableLegacySync   bool
}

// composedDeletionEffects keeps the exact effect graph inspectable by the
// black-box integration lane. The production request path still reaches these
// ports only through the fenced account-deletion application.
type composedDeletionEffects struct {
	sessions       accountdeletion.SessionRevocationPort
	subscriptions  accountdeletion.ImmediateCancellationPort
	vaultData      accountdeletion.VaultDataPurgePort
	privateObjects accountdeletion.PrivateObjectPurgePort
	accounts       accountdeletion.AccountFinalizationPort
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
	if configuration.LocalFixture != nil {
		fixtureLayout, err = localfixtureadapter.OpenLayout(configuration.LocalFixture.PrivateRoot)
		if err != nil {
			return runtimeComposition{}, func() {}, errors.New("open local fixture directories")
		}
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
	var fixtureLease *postgresadapter.LocalFixtureRuntimeLease
	var fixtureObjectDeletion *localfixtureadapter.AnchoredObjectDeletion
	var fixtureDeletionBarrier *localfixtureadapter.DeletionBarrier
	var fixtureDeletionBarrierErr error
	if configuration.LocalFixture != nil {
		fixtureLease, err = postgresadapter.AcquireLocalFixtureRuntimeLease(
			startupContext, configuration.LocalFixture.DatabaseURL,
		)
		if err != nil {
			pool.Close()
			return runtimeComposition{}, func() {}, errors.New("acquire local fixture runtime lease")
		}
	}
	var closeOnce sync.Once
	closeRuntime := func() {
		closeOnce.Do(func() {
			if fixtureDeletionBarrier != nil {
				_ = fixtureDeletionBarrier.Close()
			}
			if fixtureObjectDeletion != nil {
				_ = fixtureObjectDeletion.Close()
			}
			if fixtureLease != nil {
				_ = fixtureLease.Close()
			}
			pool.Close()
		})
	}
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
		fixtureConfig := configuration.LocalFixture
		fixtureContext := identity.VaultContext{
			AccountID: fixtureConfig.AccountID, VaultID: fixtureConfig.VaultID,
			SessionID: fixtureConfig.SessionID, SessionEpoch: fixtureConfig.SessionEpoch,
		}
		preflight, preflightErr := postgresadapter.NewLocalFixtureDeletionPreflight(
			pool, fixtureConfig.AllowedSubject, fixtureContext,
		)
		if preflightErr != nil {
			closeRuntime()
			return runtimeComposition{}, func() {}, errors.New("configure local fixture deletion preflight")
		}
		phase, phaseErr := preflight.Inspect(startupContext)
		if phaseErr == nil && phase.Phase != postgresadapter.LocalFixturePristine &&
			fixtureConfig.LegalEvidencePolicy != config.LocalFixtureDeleteLiveEvidence {
			closeRuntime()
			return runtimeComposition{}, func() {}, errors.New(
				"non-pristine local fixture requires explicit delete-live-evidence policy",
			)
		}
		if phaseErr != nil || localfixtureadapter.CheckDeletionInventory(
			startupContext, fixtureLayout, fixtureConfig.VaultID,
			deletionKeyInventory(phase), phase.ObjectKeys,
		) != nil {
			closeRuntime()
			return runtimeComposition{}, func() {}, errors.New("local fixture deletion preflight rejected")
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
			fixtureContext,
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
		fixtureObjectDeletion, err = localfixtureadapter.NewAnchoredObjectDeletion(fixtureLayout)
		if err != nil {
			closeRuntime()
			return runtimeComposition{}, func() {}, errors.New("anchor local fixture object deletion")
		}
		deletionCredentials, deletionErr := accountdeletioncredentialadapter.New(
			fixtureConfig.DeletionHMACKey[:],
		)
		if deletionErr != nil {
			closeRuntime()
			return runtimeComposition{}, func() {}, errors.New("configure local fixture deletion credentials")
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
		commerceFacts, commerceFactsErr := localfixture.NewCommerceFacts(fixtureContext)
		if commerceFactsErr != nil {
			closeRuntime()
			return runtimeComposition{}, func() {}, errors.New("configure local fixture commerce facts")
		}
		commerceProvider, providerErr := localcommerceadapter.NewProviderForCommerce(
			commerceFacts, billingStore, entitlementStore,
		)
		if providerErr != nil {
			closeRuntime()
			return runtimeComposition{}, func() {}, errors.New("configure local fixture commerce provider")
		}
		cancellation, cancellationErr := billing.NewCancellationService(billingStore, commerceProvider)
		if cancellationErr != nil {
			closeRuntime()
			return runtimeComposition{}, func() {}, errors.New("configure local fixture cancellation")
		}
		identifiers := otpadapter.NewProductionSecrets()
		fixtureClock := func() int64 { return time.Now().UnixMilli() }
		fence := runtimefoundation.NewVaultActivityFence(phase.Phase != postgresadapter.LocalFixturePristine)
		composition.disableLegacySync = true

		deletionStore, deletionStoreErr := postgresadapter.NewAccountDeletionStore(pool)
		if deletionStoreErr != nil {
			closeRuntime()
			return runtimeComposition{}, func() {}, errors.New("configure account deletion journal")
		}
		scopedDeletionStore, scopedDeletionErr := runtimefoundation.NewScopedAccountDeletionRepository(
			accountdeletion.Scope{AccountID: fixtureContext.AccountID, VaultID: fixtureContext.VaultID}, deletionStore,
		)
		billingEffect, billingEffectErr := accountdeletion.NewBillingCancellationEffect(cancellation)
		vaultStore, vaultStoreErr := postgresadapter.NewVaultDataPurgeStore(pool)
		vaultService, vaultServiceErr := vaultdata.NewService(vaultStore)
		vaultEffect, vaultEffectErr := accountdeletion.NewVaultDataPurgeEffect(vaultService)
		outbox, outboxErr := postgresadapter.NewVaultObjectDeleteOutboxDirectory(pool)
		privatePurge, privatePurgeErr := encryptedobject.NewVaultPrivateObjectPurgeService(
			encryptedobject.VaultPrivateObjectPurgeScope{
				AccountID: fixtureContext.AccountID, VaultID: fixtureContext.VaultID,
			}, outbox, fixtureObjectDeletion,
			encryptedobject.VaultPrivateObjectPurgePolicy{BatchLimit: 100, RetryDelayMilli: 1_000},
		)
		privateEffect, privateEffectErr := accountdeletion.NewPrivateObjectPurgeEffect(privatePurge)
		finalStore, finalStoreErr := postgresadapter.NewAccountFinalizationStore(pool)
		fixtureDeletionBarrier, fixtureDeletionBarrierErr = localfixtureadapter.NewDeletionBarrier(
			accountdeletion.Scope{AccountID: fixtureContext.AccountID, VaultID: fixtureContext.VaultID},
			fixtureLayout, finalStore,
		)
		legalEvidencePolicy := accountdeletion.LegalEvidenceFinalizationPolicy{
			Kind: accountdeletion.LegalEvidencePolicyUndecided,
		}
		if fixtureConfig.LegalEvidencePolicy == config.LocalFixtureDeleteLiveEvidence {
			legalEvidencePolicy.Kind = accountdeletion.LegalEvidenceDeleteLive
		}
		finalService, finalServiceErr := accountdeletion.NewAccountFinalizationService(
			accountdeletion.Scope{AccountID: fixtureContext.AccountID, VaultID: fixtureContext.VaultID},
			legalEvidencePolicy,
			fixtureDeletionBarrier, fixtureDeletionBarrier, fixtureDeletionBarrier, fixtureDeletionBarrier,
		)
		finalEffect, finalEffectErr := accountdeletion.NewAccountFinalizationEffect(finalService)
		if scopedDeletionErr != nil || billingEffectErr != nil || vaultStoreErr != nil || vaultServiceErr != nil ||
			vaultEffectErr != nil || outboxErr != nil || privatePurgeErr != nil || privateEffectErr != nil ||
			finalStoreErr != nil || fixtureDeletionBarrierErr != nil || finalServiceErr != nil || finalEffectErr != nil {
			closeRuntime()
			return runtimeComposition{}, func() {}, errors.New("configure exact fixture account deletion effects")
		}
		composition.deletionEffects = &composedDeletionEffects{
			sessions: sessionStore, subscriptions: billingEffect, vaultData: vaultEffect,
			privateObjects: privateEffect, accounts: finalEffect,
		}
		deletionService, deletionServiceErr := accountdeletion.NewService(accountdeletion.ServiceOptions{
			Repository: scopedDeletionStore, Credentials: deletionCredentials,
			Sessions: sessionStore, Subscriptions: billingEffect, VaultData: vaultEffect,
			PrivateObjects: privateEffect, Accounts: finalEffect,
			ContinuationLifetime: int64((7 * 24 * time.Hour) / time.Millisecond),
			LeaseDuration:        int64((30 * time.Second) / time.Millisecond),
			RetryPolicy:          accountdeletion.RetryPolicy{DelaysMilli: []int64{1_000, 5_000, 30_000, 60_000}},
		})
		if deletionServiceErr != nil {
			closeRuntime()
			return runtimeComposition{}, func() {}, errors.New("configure exact fixture account deletion service")
		}
		fencedDeletion, fencedDeletionErr := runtimefoundation.NewFencedAccountDeletionApplication(fence, deletionService)
		leasedDeletion, leasedDeletionErr := runtimefoundation.NewLeaseCheckedAccountDeletionApplication(
			fixtureLease, fencedDeletion,
		)
		if fencedDeletionErr != nil || leasedDeletionErr != nil {
			closeRuntime()
			return runtimeComposition{}, func() {}, errors.New("configure account deletion fence")
		}
		privacyStore, privacyStoreErr := postgresadapter.NewPrivacyRequestStore(pool)
		if privacyStoreErr != nil {
			closeRuntime()
			return runtimeComposition{}, func() {}, errors.New("configure local fixture privacy request journal")
		}
		unavailablePrivacy := privacyunavailableadapter.New()
		var deletionHandoff privacyrequest.DeletionHandoffPort = unavailablePrivacy
		if fixtureConfig.LegalEvidencePolicy == config.LocalFixtureDeleteLiveEvidence {
			deletionHandoff, err = privacydeletionadapter.New(leasedDeletion, fixtureClock)
			if err != nil {
				closeRuntime()
				return runtimeComposition{}, func() {}, errors.New("configure privacy deletion handoff")
			}
		}
		privacyService, privacyServiceErr := privacyrequest.NewService(
			privacyStore, unavailablePrivacy, unavailablePrivacy, deletionHandoff,
		)
		leasedPrivacy, leasedPrivacyErr := runtimefoundation.NewLeaseCheckedPrivacyRequestApplication(
			fixtureLease, privacyService,
		)
		if privacyServiceErr != nil || leasedPrivacyErr != nil {
			closeRuntime()
			return runtimeComposition{}, func() {}, errors.New("configure local fixture privacy request journal")
		}
		composition.privacyStore = privacyStore
		composition.privacyApplication = privacyService
		composition.privacyRequest = &httpapi.PrivacyRequestRuntime{
			ExpectedOrigin: fixtureConfig.PublicOrigin.String(), Clock: fixtureClock,
			Sessions: scopedSessions, Application: leasedPrivacy,
			NewRequestID: legalIdentifierGenerator(identifiers),
		}
		// An undecided legal-evidence policy must reject admission before the
		// vault fence is sealed, a deletion operation is created, or the session
		// is revoked. The destructive HTTP/runtime graph is therefore connected
		// only for the explicit disposable-fixture policy. This is intentionally
		// stricter than pausing at finalization: an undecided policy is not
		// authorization to perform the preceding irreversible effects. Long-lived
		// recovery applies only after an explicitly authorized operation starts.
		if fixtureConfig.LegalEvidencePolicy == config.LocalFixtureDeleteLiveEvidence {
			composition.deletionApplication = leasedDeletion
			composition.accountDeletion = &httpapi.AccountDeletionRuntime{
				ExpectedOrigin: fixtureConfig.PublicOrigin.String(), Clock: fixtureClock,
				Sessions: scopedSessions, Application: leasedDeletion,
				NewOperationID: legalIdentifierGenerator(identifiers),
			}
		}

		pristineChecks := make([]runtimefoundation.Readiness, 0, 2)
		if phase.Phase == postgresadapter.LocalFixturePristine {
			metadata, metadataErr := recoverykeyadapter.LoadFixtureMetadata(
				fixtureLayout.KeyDirectory, fixtureConfig.VaultID,
			)
			seed, seedErr := localfixture.NewSeed(
				fixtureConfig.AllowedSubject, fixtureConfig.AccountID, fixtureConfig.VaultID,
				fixtureConfig.SessionID, fixtureConfig.SessionEpoch, fixtureConfig.SessionToken, metadata,
			)
			fixtureStore, storeErr := postgresadapter.NewLocalFixtureStore(pool, seed)
			directoryReadiness, directoryErr := localfixtureadapter.NewReadiness(
				fixtureConfig.PrivateRoot, fixtureConfig.VaultID,
			)
			if metadataErr != nil || seedErr != nil || storeErr != nil || directoryErr != nil {
				closeRuntime()
				return runtimeComposition{}, func() {}, errors.New("configure pristine local fixture")
			}
			pristineChecks = append(pristineChecks, fixtureStore, directoryReadiness)
			nonces, nonceErr := contentcryptoadapter.NewDirectoryNonceReservations(fixtureLayout.NonceDirectory)
			keys, keyErr := recoverykeyadapter.NewDirectory(fixtureLayout.KeyDirectory, fixtureConfig.VaultID)
			cursors, cursorErr := syncv2.NewCursorAuthenticator(fixtureConfig.CursorHMACKey[:])
			foundation, foundationErr := runtimefoundation.NewLocalFixture(runtimefoundation.LocalFixtureOptions{
				Context: seed.Context, Sessions: scopedSessions, Objects: objects,
				NonceReservations: nonces, Keys: keys, Cursors: cursors,
				DeletionCredentials: deletionCredentials,
			})
			if nonceErr != nil || keyErr != nil || cursorErr != nil || foundationErr != nil {
				closeRuntime()
				return runtimeComposition{}, func() {}, errors.New("configure pristine local fixture foundation")
			}
			composition.localFixture = foundation
			termsStore, termsStoreErr := postgresadapter.NewTermsConsentStore(pool)
			termsService, termsErr := legal.NewTermsConsentService(
				localcommerceadapter.TermsSource{}, legalhashadapter.SHA256Hasher{}, termsStore,
			)
			evidenceStore, evidenceStoreErr := postgresadapter.NewContractEvidenceStore(pool)
			evidenceService, evidenceErr := legal.NewContractEvidenceService(
				evidenceStore, legalhashadapter.OfferSHA256Hasher{},
			)
			checkout, checkoutErr := legal.NewContractCheckoutApplication(
				evidenceService, localcommerceadapter.OfferSource{}, termsService, commerceProvider,
			)
			billingService, billingServiceErr := billing.NewService(entitlementStore, billingStore)
			entitlementService, entitlementServiceErr := entitlement.NewService(
				billingService, entitlementStore, entitlementStore, entitlement.FukamuOfflineLeasePolicy(),
			)
			scopedEntitlement, scopedEntitlementErr := runtimefoundation.NewScopedEntitlement(
				seed.Context, localfixture.FixtureTimestamp, entitlementService,
			)
			journalDirectory, journalErr := postgresadapter.NewSyncV2JournalDirectory(pool)
			metadataDirectory, metadataDirectoryErr := postgresadapter.NewSyncV2MetadataDirectory(pool)
			quotaDirectory, quotaErr := postgresadapter.NewQuotaLedgerDirectory(pool)
			keyrings, keyringErr := postgresadapter.NewVaultDEKStore(pool)
			encryption, encryptionErr := cryptocontent.NewService(
				keys, contentcryptoadapter.NewSecureRandomNonceGenerator(), nonces, contentcryptoadapter.AES256GCM{},
			)
			contents, contentsErr := syncv2.NewEncryptedContentDirectory(
				metadataDirectory, objects, objectstorageadapter.NewRandomObjectKeyGenerator(), encryption, keyrings,
			)
			application, applicationErr := syncv2.NewApplication(
				journalDirectory, contents, cursors, quotaDirectory, 60_000,
			)
			fencedSync, fencedSyncErr := runtimefoundation.NewFencedSyncV2Application(fence, application)
			leasedSync, leasedSyncErr := runtimefoundation.NewLeaseCheckedSyncV2Application(
				fixtureLease, fencedSync,
			)
			if termsStoreErr != nil || termsErr != nil || evidenceStoreErr != nil || evidenceErr != nil ||
				checkoutErr != nil || billingServiceErr != nil || entitlementServiceErr != nil ||
				scopedEntitlementErr != nil || journalErr != nil || metadataDirectoryErr != nil ||
				quotaErr != nil || keyringErr != nil || encryptionErr != nil || contentsErr != nil ||
				applicationErr != nil || fencedSyncErr != nil || leasedSyncErr != nil {
				closeRuntime()
				return runtimeComposition{}, func() {}, errors.New("configure pristine local fixture applications")
			}
			composition.legal = &httpapi.LegalRuntime{
				ExpectedOrigin: fixtureConfig.PublicOrigin.String(), Clock: fixtureClock,
				Sessions: scopedSessions, Terms: termsService, Checkout: checkout,
				NewTermsConsentID: legalIdentifierGenerator(identifiers), NewContractEvidenceID: legalIdentifierGenerator(identifiers),
			}
			composition.billingCancellation = &httpapi.BillingCancellationRuntime{
				ExpectedOrigin: fixtureConfig.PublicOrigin.String(), Clock: fixtureClock,
				Sessions: scopedSessions, Cancellation: cancellation,
			}
			composition.syncV2 = &httpapi.SyncV2Runtime{
				ExpectedOrigin: fixtureConfig.PublicOrigin.String(), Clock: fixtureClock,
				Sessions: scopedSessions, Entitlement: scopedEntitlement, Application: leasedSync,
			}
			composition.syncV2Application = leasedSync
		}
		phaseReadiness := &localFixtureDeletionReadiness{
			preflight: preflight, layout: fixtureLayout, vaultID: fixtureConfig.VaultID,
			pristine: pristineChecks,
		}
		aggregate, aggregateErr := runtimefoundation.NewAggregateReadiness(
			fixtureLease, schemaReadiness, phaseReadiness,
		)
		if aggregateErr != nil || aggregate.Check(startupContext) != nil {
			closeRuntime()
			return runtimeComposition{}, func() {}, errors.New("local fixture is not ready")
		}
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

// localFixtureDeletionReadiness re-runs the exact database and filesystem
// inventory checks for every readiness request. The pristine-only seed checks
// are intentionally skipped after deletion has irreversibly removed the key
// and live owner rows.
type localFixtureDeletionReadiness struct {
	preflight *postgresadapter.LocalFixtureDeletionPreflight
	layout    localfixtureadapter.Layout
	vaultID   identity.VaultID
	pristine  []runtimefoundation.Readiness
}

func (readiness *localFixtureDeletionReadiness) Check(ctx context.Context) error {
	if readiness == nil || readiness.preflight == nil || ctx == nil {
		return runtimefoundation.ErrNotReady
	}
	state, err := readiness.preflight.Inspect(ctx)
	if err != nil || localfixtureadapter.CheckDeletionInventory(
		ctx,
		readiness.layout,
		readiness.vaultID,
		deletionKeyInventory(state),
		state.ObjectKeys,
	) != nil {
		return runtimefoundation.ErrNotReady
	}
	if state.Phase != postgresadapter.LocalFixturePristine {
		return nil
	}
	if len(readiness.pristine) == 0 {
		return runtimefoundation.ErrNotReady
	}
	for _, check := range readiness.pristine {
		if check == nil || check.Check(ctx) != nil {
			return runtimefoundation.ErrNotReady
		}
	}
	return nil
}

func deletionKeyInventory(
	state postgresadapter.LocalFixtureDeletionState,
) localfixtureadapter.DeletionKeyInventory {
	return localfixtureadapter.DeletionKeyInventory{
		DatabaseMetadata:      state.WrappedKeyMetadata,
		AllowResidualFile:     state.Phase == postgresadapter.LocalFixtureDeleting,
		ForbidFile:            state.Phase == postgresadapter.LocalFixtureCompleted,
		ForbidObjectFiles:     state.Phase == postgresadapter.LocalFixtureCompleted,
		ForbidNonceFiles:      state.Phase == postgresadapter.LocalFixtureCompleted,
		AllowObjectQuarantine: state.Phase == postgresadapter.LocalFixtureDeleting,
		AllowNonceQuarantine:  state.Phase == postgresadapter.LocalFixtureDeleting,
	}
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
	if fixture.LegalEvidencePolicy != config.LocalFixtureLegalEvidenceUndecided &&
		fixture.LegalEvidencePolicy != config.LocalFixtureDeleteLiveEvidence {
		return errors.New("local fixture legal-evidence policy is invalid")
	}
	return nil
}
