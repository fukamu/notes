package accountdeletion

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"math"
	"regexp"
	"strconv"
	"unicode/utf8"
)

const MaximumRequestBytes int64 = 2_048

var (
	ErrInvalidRequest        = errors.New("invalid account deletion request")
	ErrInvalidPublicResponse = errors.New("invalid account deletion public response")
	continuationTokenPattern = regexp.MustCompile(`^ad1\.([A-Za-z0-9_-]{43})\.(0|[1-9][0-9]{0,9})$`)
)

type ContinuationToken string

type StartCommand struct {
	IdempotencyKey IdempotencyKey
}

type ResumeCommand struct {
	ContinuationToken ContinuationToken
}

type PublicResponse struct {
	Status            PublicStatusKind
	RetryAt           *int64
	ContinuationToken ContinuationToken
}

func ParseContinuationToken(value string) (ContinuationToken, error) {
	matches := continuationTokenPattern.FindStringSubmatch(value)
	if len(matches) != 3 {
		return "", ErrInvalidRequest
	}
	if _, err := ParseContinuationSecret(matches[1]); err != nil {
		return "", ErrInvalidRequest
	}
	sequence, err := strconv.ParseInt(matches[2], 10, 64)
	if err != nil || sequence < 0 || sequence > MaximumRevision {
		return "", ErrInvalidRequest
	}
	return ContinuationToken(value), nil
}

func CreateContinuationToken(secret ContinuationSecret, sequence int64) (ContinuationToken, error) {
	if _, err := ParseContinuationSecret(string(secret)); err != nil || sequence < 0 || sequence > MaximumRevision {
		return "", ErrInvalidRequest
	}
	return ParseContinuationToken("ad1." + string(secret) + "." + strconv.FormatInt(sequence, 10))
}

func ContinuationTokenParts(token ContinuationToken) (ContinuationSecret, int64, error) {
	parsed, err := ParseContinuationToken(string(token))
	if err != nil {
		return "", 0, err
	}
	matches := continuationTokenPattern.FindStringSubmatch(string(parsed))
	secret, secretErr := ParseContinuationSecret(matches[1])
	sequence, sequenceErr := strconv.ParseInt(matches[2], 10, 64)
	if secretErr != nil || sequenceErr != nil {
		return "", 0, ErrInvalidRequest
	}
	return secret, sequence, nil
}

func DecodeStartCommand(content []byte) (StartCommand, error) {
	fields, err := decodeObject(content, ErrInvalidRequest)
	if err != nil || !exactKeys(fields, "idempotencyKey") {
		return StartCommand{}, ErrInvalidRequest
	}
	value, err := decodeString(fields["idempotencyKey"], ErrInvalidRequest)
	if err != nil {
		return StartCommand{}, err
	}
	key, err := ParseIdempotencyKey(value)
	if err != nil {
		return StartCommand{}, ErrInvalidRequest
	}
	return StartCommand{IdempotencyKey: key}, nil
}

func DecodeResumeCommand(content []byte) (ResumeCommand, error) {
	fields, err := decodeObject(content, ErrInvalidRequest)
	if err != nil || !exactKeys(fields, "continuationToken") {
		return ResumeCommand{}, ErrInvalidRequest
	}
	value, err := decodeString(fields["continuationToken"], ErrInvalidRequest)
	if err != nil {
		return ResumeCommand{}, err
	}
	token, err := ParseContinuationToken(value)
	if err != nil {
		return ResumeCommand{}, ErrInvalidRequest
	}
	return ResumeCommand{ContinuationToken: token}, nil
}

func EncodePublicResponse(response PublicResponse) ([]byte, error) {
	if !validPublicResponse(response) {
		return nil, ErrInvalidPublicResponse
	}
	wire := struct {
		Status            PublicStatusKind  `json:"status"`
		RetryAt           *int64            `json:"retryAt,omitempty"`
		ContinuationToken ContinuationToken `json:"continuationToken,omitempty"`
	}{Status: response.Status, RetryAt: response.RetryAt, ContinuationToken: response.ContinuationToken}
	content, err := json.Marshal(wire)
	if err != nil {
		return nil, ErrInvalidPublicResponse
	}
	return content, nil
}

func DecodePublicResponse(content []byte) (PublicResponse, error) {
	fields, err := decodeObject(content, ErrInvalidPublicResponse)
	if err != nil {
		return PublicResponse{}, err
	}
	statusValue, err := decodeString(fields["status"], ErrInvalidPublicResponse)
	if err != nil {
		return PublicResponse{}, err
	}
	status := PublicStatusKind(statusValue)
	keys := []string{"status"}
	if status == PublicInProgress {
		keys = append(keys, "continuationToken")
	}
	if status == PublicRetryWait {
		keys = append(keys, "retryAt", "continuationToken")
	}
	if !exactKeys(fields, keys...) {
		return PublicResponse{}, ErrInvalidPublicResponse
	}
	response := PublicResponse{Status: status}
	if status == PublicInProgress || status == PublicRetryWait {
		tokenValue, tokenErr := decodeString(fields["continuationToken"], ErrInvalidPublicResponse)
		token, parseErr := ParseContinuationToken(tokenValue)
		if tokenErr != nil || parseErr != nil {
			return PublicResponse{}, ErrInvalidPublicResponse
		}
		response.ContinuationToken = token
	}
	if status == PublicRetryWait {
		retryAt, retryErr := decodeInteger(fields["retryAt"], ErrInvalidPublicResponse)
		if retryErr != nil {
			return PublicResponse{}, ErrInvalidPublicResponse
		}
		response.RetryAt = &retryAt
	}
	if !validPublicResponse(response) {
		return PublicResponse{}, ErrInvalidPublicResponse
	}
	return response, nil
}

func validPublicResponse(response PublicResponse) bool {
	switch response.Status {
	case PublicInProgress:
		_, err := ParseContinuationToken(string(response.ContinuationToken))
		return err == nil && response.RetryAt == nil
	case PublicRetryWait:
		_, err := ParseContinuationToken(string(response.ContinuationToken))
		return err == nil && response.RetryAt != nil && validTimestamp(*response.RetryAt)
	case PublicFailed, PublicCompleted:
		return response.RetryAt == nil && response.ContinuationToken == ""
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
	var number json.Number
	if err := decoder.Decode(&number); err != nil || !decoderAtEnd(decoder) {
		return 0, fixedError
	}
	parsed, err := strconv.ParseFloat(string(number), 64)
	if err != nil || math.IsInf(parsed, 0) || math.IsNaN(parsed) || math.Trunc(parsed) != parsed ||
		parsed < 0 || parsed > 9_007_199_254_740_991 {
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
