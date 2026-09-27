package privacyrequest

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"math"
	"strconv"
	"unicode/utf8"

	"github.com/fukamu/notes/backend/internal/identity"
)

const MaximumRequestBytes int64 = 2_048

var (
	ErrInvalidRequest        = errors.New("invalid privacy request")
	ErrInvalidPublicResponse = errors.New("invalid privacy request public response")
)

type SubmitCommand struct {
	SubmissionID SubmissionID
	RequestKind  RequestKind
}

type StatusCommand struct {
	RequestID RequestID
}

type PublicStatus struct {
	RequestID   RequestID
	RequestKind RequestKind
	RequestedAt int64
	UpdatedAt   int64
	Status      StateKind
	Outcome     Outcome
	Retryable   *bool
}

func DecodeSubmitCommand(content []byte) (SubmitCommand, error) {
	fields, err := decodeObject(content, ErrInvalidRequest)
	if err != nil || !exactKeys(fields, "submissionId", "requestKind") {
		return SubmitCommand{}, ErrInvalidRequest
	}
	submissionValue, err := decodeString(fields["submissionId"], ErrInvalidRequest)
	if err != nil {
		return SubmitCommand{}, err
	}
	submissionID, err := ParseSubmissionID(submissionValue)
	if err != nil {
		return SubmitCommand{}, ErrInvalidRequest
	}
	kindValue, err := decodeString(fields["requestKind"], ErrInvalidRequest)
	kind := RequestKind(kindValue)
	if err != nil || !ValidRequestKind(kind) {
		return SubmitCommand{}, ErrInvalidRequest
	}
	return SubmitCommand{SubmissionID: submissionID, RequestKind: kind}, nil
}

func DecodeStatusCommand(content []byte) (StatusCommand, error) {
	fields, err := decodeObject(content, ErrInvalidRequest)
	if err != nil || !exactKeys(fields, "requestId") {
		return StatusCommand{}, ErrInvalidRequest
	}
	requestValue, err := decodeString(fields["requestId"], ErrInvalidRequest)
	if err != nil {
		return StatusCommand{}, err
	}
	requestID, err := ParseRequestID(requestValue)
	if err != nil {
		return StatusCommand{}, ErrInvalidRequest
	}
	return StatusCommand{RequestID: requestID}, nil
}

func PublicStatusFromRecord(record Record) (PublicStatus, error) {
	if !ValidRecord(record) {
		return PublicStatus{}, ErrInvalidPublicResponse
	}
	status := PublicStatus{
		RequestID: record.RequestID, RequestKind: record.RequestKind,
		RequestedAt: record.RequestedAt, UpdatedAt: record.UpdatedAt,
		Status: record.State.Kind(),
	}
	switch state := record.State.(type) {
	case Completed:
		status.Outcome = state.Outcome
	case Failed:
		retryable := state.Retryable
		status.Retryable = &retryable
	}
	return status, nil
}

func EncodePublicStatus(status PublicStatus) ([]byte, error) {
	if !validPublicStatus(status) {
		return nil, ErrInvalidPublicResponse
	}
	base := struct {
		RequestID   RequestID   `json:"requestId"`
		RequestKind RequestKind `json:"requestKind"`
		RequestedAt int64       `json:"requestedAt"`
		UpdatedAt   int64       `json:"updatedAt"`
		Status      StateKind   `json:"status"`
		Outcome     Outcome     `json:"outcome,omitempty"`
		Retryable   *bool       `json:"retryable,omitempty"`
	}{
		RequestID: status.RequestID, RequestKind: status.RequestKind,
		RequestedAt: status.RequestedAt, UpdatedAt: status.UpdatedAt,
		Status: status.Status, Outcome: status.Outcome, Retryable: status.Retryable,
	}
	content, err := json.Marshal(base)
	if err != nil {
		return nil, ErrInvalidPublicResponse
	}
	return content, nil
}

func DecodePublicStatus(content []byte) (PublicStatus, error) {
	fields, err := decodeObject(content, ErrInvalidPublicResponse)
	if err != nil {
		return PublicStatus{}, err
	}
	statusValue, err := decodeString(fields["status"], ErrInvalidPublicResponse)
	if err != nil {
		return PublicStatus{}, err
	}
	statusKind := StateKind(statusValue)
	wantKeys := []string{"requestId", "requestKind", "requestedAt", "updatedAt", "status"}
	if statusKind == StateCompleted {
		wantKeys = append(wantKeys, "outcome")
	}
	if statusKind == StateFailed {
		wantKeys = append(wantKeys, "retryable")
	}
	if !exactKeys(fields, wantKeys...) {
		return PublicStatus{}, ErrInvalidPublicResponse
	}
	requestValue, requestErr := decodeString(fields["requestId"], ErrInvalidPublicResponse)
	requestID, requestIDErr := ParseRequestID(requestValue)
	kindValue, kindErr := decodeString(fields["requestKind"], ErrInvalidPublicResponse)
	kind := RequestKind(kindValue)
	requestedAt, requestedErr := decodeInteger(fields["requestedAt"], ErrInvalidPublicResponse)
	updatedAt, updatedErr := decodeInteger(fields["updatedAt"], ErrInvalidPublicResponse)
	result := PublicStatus{
		RequestID: requestID, RequestKind: kind, RequestedAt: requestedAt,
		UpdatedAt: updatedAt, Status: statusKind,
	}
	if statusKind == StateCompleted {
		outcomeValue, outcomeErr := decodeString(fields["outcome"], ErrInvalidPublicResponse)
		if outcomeErr != nil {
			return PublicStatus{}, ErrInvalidPublicResponse
		}
		result.Outcome = Outcome(outcomeValue)
	}
	if statusKind == StateFailed {
		var retryable bool
		decoder := json.NewDecoder(bytes.NewReader(fields["retryable"]))
		if err := decoder.Decode(&retryable); err != nil || !decoderAtEnd(decoder) {
			return PublicStatus{}, ErrInvalidPublicResponse
		}
		result.Retryable = &retryable
	}
	if requestErr != nil || requestIDErr != nil || kindErr != nil || requestedErr != nil || updatedErr != nil ||
		!validPublicStatus(result) {
		return PublicStatus{}, ErrInvalidPublicResponse
	}
	return result, nil
}

func validPublicStatus(status PublicStatus) bool {
	if _, err := ParseRequestID(string(status.RequestID)); err != nil ||
		!ValidRequestKind(status.RequestKind) || !validTimestamp(status.RequestedAt) ||
		!validTimestamp(status.UpdatedAt) || status.UpdatedAt < status.RequestedAt {
		return false
	}
	switch status.Status {
	case StateVerificationPending, StateReady, StateProcessing, StateRejected:
		return status.Outcome == "" && status.Retryable == nil
	case StateCompleted:
		return status.Retryable == nil && outcomeMatchesKind(status.RequestKind, status.Outcome)
	case StateFailed:
		return status.Outcome == "" && status.Retryable != nil
	default:
		return false
	}
}

func decodeObject(content []byte, fixedError error) (map[string]json.RawMessage, error) {
	if len(content) == 0 || int64(len(content)) > MaximumRequestBytes || !utf8.Valid(content) ||
		!validSurrogateEscapes(content) {
		return nil, fixedError
	}
	content = bytes.TrimPrefix(content, []byte{0xef, 0xbb, 0xbf})
	decoder := json.NewDecoder(bytes.NewReader(content))
	opening, err := decoder.Token()
	if err != nil || opening != json.Delim('{') {
		return nil, fixedError
	}
	fields := make(map[string]json.RawMessage)
	for decoder.More() {
		keyToken, err := decoder.Token()
		key, ok := keyToken.(string)
		if err != nil || !ok {
			return nil, fixedError
		}
		if _, duplicate := fields[key]; duplicate {
			return nil, fixedError
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return nil, fixedError
		}
		fields[key] = value
	}
	closing, err := decoder.Token()
	if err != nil || closing != json.Delim('}') || !decoderAtEnd(decoder) {
		return nil, fixedError
	}
	return fields, nil
}

func decodeString(content []byte, fixedError error) (string, error) {
	if !utf8.Valid(content) || !validSurrogateEscapes(content) {
		return "", fixedError
	}
	var value string
	decoder := json.NewDecoder(bytes.NewReader(content))
	if err := decoder.Decode(&value); err != nil || !decoderAtEnd(decoder) || !utf8.ValidString(value) {
		return "", fixedError
	}
	return value, nil
}

func decodeInteger(content []byte, fixedError error) (int64, error) {
	decoder := json.NewDecoder(bytes.NewReader(content))
	decoder.UseNumber()
	var value json.Number
	if err := decoder.Decode(&value); err != nil || !decoderAtEnd(decoder) {
		return 0, fixedError
	}
	parsed, err := strconv.ParseFloat(string(value), 64)
	if err != nil || math.IsInf(parsed, 0) || math.IsNaN(parsed) ||
		math.Trunc(parsed) != parsed || parsed < 0 || parsed > float64(identity.MaximumSafeInteger) {
		return 0, fixedError
	}
	return int64(parsed), nil
}

func exactKeys(fields map[string]json.RawMessage, keys ...string) bool {
	if len(fields) != len(keys) {
		return false
	}
	for _, key := range keys {
		if _, ok := fields[key]; !ok {
			return false
		}
	}
	return true
}

func decoderAtEnd(decoder *json.Decoder) bool {
	var extra any
	return errors.Is(decoder.Decode(&extra), io.EOF)
}

func validSurrogateEscapes(content []byte) bool {
	for index := 1; index+1 < len(content); index++ {
		if content[index] != '\\' {
			continue
		}
		index++
		if index >= len(content)-1 {
			return false
		}
		if content[index] != 'u' {
			continue
		}
		codeUnit, ok := decodeHexCodeUnit(content, index+1)
		if !ok {
			return false
		}
		index += 4
		switch {
		case codeUnit >= 0xdc00 && codeUnit <= 0xdfff:
			return false
		case codeUnit >= 0xd800 && codeUnit <= 0xdbff:
			if index+6 >= len(content) || content[index+1] != '\\' || content[index+2] != 'u' {
				return false
			}
			low, ok := decodeHexCodeUnit(content, index+3)
			if !ok || low < 0xdc00 || low > 0xdfff {
				return false
			}
			index += 6
		}
	}
	return true
}

func decodeHexCodeUnit(content []byte, start int) (uint64, bool) {
	if start+4 > len(content) {
		return 0, false
	}
	value, err := strconv.ParseUint(string(content[start:start+4]), 16, 16)
	return value, err == nil
}
