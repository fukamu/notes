package privacydeletion

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"errors"
	"fmt"
	"hash"
	"strings"

	"github.com/fukamu/notes/backend/internal/accountdeletion"
	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/fukamu/notes/backend/internal/privacyrequest"
)

var ErrInvalidHandoffConfiguration = errors.New("invalid privacy deletion handoff configuration")

const (
	idempotencyDomain = "fukamu-privacy-deletion-idempotency/v1"
	operationDomain   = "fukamu-privacy-deletion-operation/v1"

	failureConflict      privacyrequest.FailureCode = "account-deletion-conflict"
	failureInvalid       privacyrequest.FailureCode = "account-deletion-invalid"
	failureInvalidResult privacyrequest.FailureCode = "account-deletion-invalid-result"
	failureUnavailable   privacyrequest.FailureCode = "account-deletion-unavailable"
)

type AccountDeletionStarter interface {
	Start(
		context.Context,
		accountdeletion.Scope,
		accountdeletion.StartCommand,
		accountdeletion.OperationID,
		int64,
	) (accountdeletion.ApplicationResult, error)
}

var (
	_ AccountDeletionStarter             = (*accountdeletion.Service)(nil)
	_ privacyrequest.DeletionHandoffPort = (*Handoff)(nil)
)

type Clock func() int64

type Handoff struct {
	starter AccountDeletionStarter
	clock   Clock
}

type StartIdentity struct {
	Scope       accountdeletion.Scope
	Command     accountdeletion.StartCommand
	OperationID accountdeletion.OperationID
}

func New(starter AccountDeletionStarter, clock Clock) (*Handoff, error) {
	if starter == nil || clock == nil {
		return nil, ErrInvalidHandoffConfiguration
	}
	return &Handoff{starter: starter, clock: clock}, nil
}

func DeriveStartIdentity(scope privacyrequest.Scope, requestID privacyrequest.RequestID) (StartIdentity, error) {
	if !privacyrequest.ValidScope(scope) {
		return StartIdentity{}, ErrInvalidHandoffConfiguration
	}
	parsedRequestID, err := privacyrequest.ParseRequestID(string(requestID))
	if err != nil {
		return StartIdentity{}, ErrInvalidHandoffConfiguration
	}
	deletionScope := accountdeletion.Scope{AccountID: scope.AccountID, VaultID: scope.VaultID}
	if !accountdeletion.ValidScope(deletionScope) {
		return StartIdentity{}, ErrInvalidHandoffConfiguration
	}
	idempotencyDigest := deriveDigest(idempotencyDomain, scope, parsedRequestID)
	idempotencyKey, err := accountdeletion.ParseIdempotencyKey(
		base64.RawURLEncoding.EncodeToString(idempotencyDigest[:]),
	)
	if err != nil {
		return StartIdentity{}, ErrInvalidHandoffConfiguration
	}
	operationID, err := deriveOperationID(scope, parsedRequestID)
	if err != nil {
		return StartIdentity{}, err
	}
	return StartIdentity{
		Scope:       deletionScope,
		Command:     accountdeletion.StartCommand{IdempotencyKey: idempotencyKey},
		OperationID: operationID,
	}, nil
}

func (handoff *Handoff) StartExistingAccountDeletion(
	ctx context.Context,
	scope privacyrequest.Scope,
	requestID privacyrequest.RequestID,
) (privacyrequest.DeletionHandoffResult, error) {
	if handoff == nil || handoff.starter == nil || handoff.clock == nil {
		return failed(failureUnavailable, true), nil
	}
	derived, err := DeriveStartIdentity(scope, requestID)
	if err != nil {
		return failed(failureInvalid, false), nil
	}
	requestedAt := handoff.clock()
	if requestedAt < 0 || requestedAt > identity.MaximumSafeInteger {
		return failed(failureInvalid, false), nil
	}
	result, err := handoff.starter.Start(
		ctx,
		derived.Scope,
		derived.Command,
		derived.OperationID,
		requestedAt,
	)
	if err != nil {
		return failed(failureUnavailable, true), nil
	}
	switch result.Kind {
	case accountdeletion.ApplicationAccepted:
		if result.Response == nil {
			return failed(failureInvalidResult, false), nil
		}
		if _, err := accountdeletion.EncodePublicResponse(*result.Response); err != nil {
			return failed(failureInvalidResult, false), nil
		}
		return privacyrequest.DeletionHandoffResult{Kind: privacyrequest.DeletionHandoffStarted}, nil
	case accountdeletion.ApplicationRejected:
		switch result.Reason {
		case accountdeletion.ApplicationCredentialConflict:
			return failed(failureConflict, false), nil
		case accountdeletion.ApplicationUnavailable:
			return failed(failureUnavailable, true), nil
		case accountdeletion.ApplicationInvalidInput, accountdeletion.ApplicationInvalidCapability:
			return failed(failureInvalid, false), nil
		default:
			return failed(failureInvalidResult, false), nil
		}
	default:
		return failed(failureInvalidResult, false), nil
	}
}

func deriveOperationID(scope privacyrequest.Scope, requestID privacyrequest.RequestID) (accountdeletion.OperationID, error) {
	encoded := strings.ReplaceAll(string(requestID), "-", "")
	requestBytes, err := hex.DecodeString(encoded)
	if err != nil || len(requestBytes) != 16 {
		return "", ErrInvalidHandoffConfiguration
	}
	digest := deriveDigest(operationDomain, scope, requestID)
	var operationBytes [16]byte
	copy(operationBytes[:6], requestBytes[:6])
	copy(operationBytes[6:], digest[:10])
	operationBytes[6] = (operationBytes[6] & 0x0f) | 0x70
	operationBytes[8] = (operationBytes[8] & 0x3f) | 0x80
	value := fmt.Sprintf(
		"%x-%x-%x-%x-%x",
		operationBytes[0:4],
		operationBytes[4:6],
		operationBytes[6:8],
		operationBytes[8:10],
		operationBytes[10:16],
	)
	operationID, err := accountdeletion.ParseOperationID(value)
	if err != nil {
		return "", ErrInvalidHandoffConfiguration
	}
	return operationID, nil
}

func deriveDigest(domain string, scope privacyrequest.Scope, requestID privacyrequest.RequestID) [sha256.Size]byte {
	digest := sha256.New()
	writeFrame(digest, domain)
	writeFrame(digest, string(scope.AccountID))
	writeFrame(digest, string(scope.VaultID))
	writeFrame(digest, string(requestID))
	var result [sha256.Size]byte
	copy(result[:], digest.Sum(nil))
	return result
}

func writeFrame(writer hash.Hash, value string) {
	var length [4]byte
	binary.BigEndian.PutUint32(length[:], uint32(len(value)))
	_, _ = writer.Write(length[:])
	_, _ = writer.Write([]byte(value))
}

func failed(code privacyrequest.FailureCode, retryable bool) privacyrequest.DeletionHandoffResult {
	return privacyrequest.DeletionHandoffResult{
		Kind: privacyrequest.DeletionHandoffFailed, FailureCode: code, Retryable: retryable,
	}
}
