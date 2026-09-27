package synclegacy

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

var uuidV7Pattern = regexp.MustCompile(
	`^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-7[0-9A-Fa-f]{3}-[89ABab][0-9A-Fa-f]{3}-[0-9A-Fa-f]{12}$`,
)

func DecodeRequest(content []byte) (Request, error) {
	if len(content) == 0 || len(content) > MaximumPayloadBytes || !utf8.Valid(content) {
		return Request{}, ErrInvalidRequest
	}
	fields, err := decodeObject(content, ErrInvalidRequest)
	if err != nil || !hasExactKeys(fields, "deviceId", "mutations") {
		return Request{}, ErrInvalidRequest
	}
	deviceID, err := decodeUUID[DeviceID](fields["deviceId"], ErrInvalidRequest)
	if err != nil {
		return Request{}, ErrInvalidRequest
	}
	items, err := decodeArray(fields["mutations"], MaximumMutations, ErrInvalidRequest)
	if err != nil {
		return Request{}, ErrInvalidRequest
	}
	mutations := make([]Mutation, 0, len(items))
	seen := make(map[MutationID]struct{}, len(items))
	for _, item := range items {
		mutation, err := decodeMutation(item)
		if err != nil {
			return Request{}, ErrInvalidRequest
		}
		if _, duplicate := seen[mutation.MutationID]; duplicate {
			return Request{}, ErrInvalidRequest
		}
		seen[mutation.MutationID] = struct{}{}
		mutations = append(mutations, mutation)
	}
	return Request{DeviceID: deviceID, Mutations: mutations}, nil
}

func decodeMutation(content json.RawMessage) (Mutation, error) {
	fields, err := decodeObject(content, ErrInvalidRequest)
	if err != nil || !hasExactKeys(
		fields,
		"mutationId",
		"cardId",
		"baseServerRevision",
		"title",
		"body",
		"createdAt",
		"updatedAt",
		"kind",
		"conflictIds",
	) {
		return Mutation{}, ErrInvalidRequest
	}
	mutationID, err := decodeUUID[MutationID](fields["mutationId"], ErrInvalidRequest)
	if err != nil {
		return Mutation{}, err
	}
	cardID, err := decodeUUID[CardID](fields["cardId"], ErrInvalidRequest)
	if err != nil {
		return Mutation{}, err
	}
	title, err := decodeBoundedString(fields["title"], MaximumTitleLength, ErrInvalidRequest)
	if err != nil {
		return Mutation{}, err
	}
	body, err := decodeBody(fields["body"], ErrInvalidRequest)
	if err != nil {
		return Mutation{}, err
	}
	createdAt, err := decodeSafeInteger(fields["createdAt"], false, ErrInvalidRequest)
	if err != nil {
		return Mutation{}, err
	}
	updatedAt, err := decodeSafeInteger(fields["updatedAt"], false, ErrInvalidRequest)
	if err != nil || createdAt > updatedAt {
		return Mutation{}, ErrInvalidRequest
	}
	kindValue, err := decodeBoundedString(fields["kind"], 16, ErrInvalidRequest)
	if err != nil {
		return Mutation{}, err
	}
	conflictItems, err := decodeArray(fields["conflictIds"], MaximumConflictIDs, ErrInvalidRequest)
	if err != nil {
		return Mutation{}, err
	}
	conflictIDs := make([]ConflictID, 0, len(conflictItems))
	seenConflicts := make(map[ConflictID]struct{}, len(conflictItems))
	for _, item := range conflictItems {
		identifier, err := decodeUUID[ConflictID](item, ErrInvalidRequest)
		if err != nil {
			return Mutation{}, err
		}
		if _, duplicate := seenConflicts[identifier]; duplicate {
			return Mutation{}, ErrInvalidRequest
		}
		seenConflicts[identifier] = struct{}{}
		conflictIDs = append(conflictIDs, identifier)
	}

	var baseRevision *int64
	if !bytes.Equal(bytes.TrimSpace(fields["baseServerRevision"]), []byte("null")) {
		value, err := decodeSafeInteger(fields["baseServerRevision"], true, ErrInvalidRequest)
		if err != nil {
			return Mutation{}, err
		}
		baseRevision = &value
	}
	kind := MutationKind(kindValue)
	switch kind {
	case MutationUpsert:
		if len(conflictIDs) != 0 {
			return Mutation{}, ErrInvalidRequest
		}
	case MutationResolve:
		if baseRevision == nil || len(conflictIDs) == 0 {
			return Mutation{}, ErrInvalidRequest
		}
	default:
		return Mutation{}, ErrInvalidRequest
	}
	return Mutation{
		MutationID:         mutationID,
		CardID:             cardID,
		BaseServerRevision: baseRevision,
		Title:              title,
		Body:               body,
		CreatedAt:          createdAt,
		UpdatedAt:          updatedAt,
		Kind:               kind,
		ConflictIDs:        conflictIDs,
	}, nil
}

func decodeBody(content json.RawMessage, fixedError error) ([]BodySegment, error) {
	items, err := decodeArray(content, MaximumBodySegments, fixedError)
	if err != nil {
		return nil, fixedError
	}
	segments := make([]BodySegment, 0, len(items))
	for _, item := range items {
		fields, err := decodeObject(item, fixedError)
		if err != nil {
			return nil, fixedError
		}
		kind, err := decodeBoundedString(fields["type"], 16, fixedError)
		if err != nil {
			return nil, fixedError
		}
		switch SegmentKind(kind) {
		case SegmentText:
			if !hasExactKeys(fields, "type", "text") {
				return nil, fixedError
			}
			text, err := decodeBoundedString(fields["text"], MaximumTextLength, fixedError)
			if err != nil {
				return nil, fixedError
			}
			segments = append(segments, BodySegment{Kind: SegmentText, Text: text})
		case SegmentLink:
			if !hasExactKeys(fields, "type", "targetCardId") {
				return nil, fixedError
			}
			target, err := decodeUUID[CardID](fields["targetCardId"], fixedError)
			if err != nil {
				return nil, fixedError
			}
			segments = append(segments, BodySegment{Kind: SegmentLink, TargetCardID: target})
		default:
			return nil, fixedError
		}
	}
	return segments, nil
}

func decodeObject(content []byte, fixedError error) (map[string]json.RawMessage, error) {
	decoder := json.NewDecoder(bytes.NewReader(content))
	opening, err := decoder.Token()
	if err != nil || opening != json.Delim('{') {
		return nil, fixedError
	}
	fields := make(map[string]json.RawMessage)
	for decoder.More() {
		keyToken, err := decoder.Token()
		if err != nil {
			return nil, fixedError
		}
		key, ok := keyToken.(string)
		if !ok {
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

func decodeArray(content []byte, maximum int, fixedError error) ([]json.RawMessage, error) {
	decoder := json.NewDecoder(bytes.NewReader(content))
	opening, err := decoder.Token()
	if err != nil || opening != json.Delim('[') {
		return nil, fixedError
	}
	values := make([]json.RawMessage, 0)
	for decoder.More() {
		if len(values) >= maximum {
			return nil, fixedError
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return nil, fixedError
		}
		values = append(values, value)
	}
	closing, err := decoder.Token()
	if err != nil || closing != json.Delim(']') || !decoderAtEnd(decoder) {
		return nil, fixedError
	}
	return values, nil
}

func decodeBoundedString(content []byte, maximum int, fixedError error) (string, error) {
	if !validJSONSurrogateEscapes(content) {
		return "", fixedError
	}
	var value string
	decoder := json.NewDecoder(bytes.NewReader(content))
	if err := decoder.Decode(&value); err != nil || !decoderAtEnd(decoder) || utf16Length(value) > maximum {
		return "", fixedError
	}
	return value, nil
}

func validJSONSurrogateEscapes(content []byte) bool {
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

func decodeSafeInteger(content []byte, positive bool, fixedError error) (int64, error) {
	decoder := json.NewDecoder(bytes.NewReader(content))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil || !decoderAtEnd(decoder) {
		return 0, fixedError
	}
	number, ok := value.(json.Number)
	if !ok {
		return 0, fixedError
	}
	parsed, err := strconv.ParseFloat(string(number), 64)
	if err != nil || math.IsInf(parsed, 0) || math.IsNaN(parsed) || math.Trunc(parsed) != parsed ||
		parsed < 0 || parsed > float64(MaximumSafeInteger) || (positive && parsed < 1) {
		return 0, fixedError
	}
	return int64(parsed), nil
}

func decodeUUID[T ~string](content []byte, fixedError error) (T, error) {
	value, err := decodeBoundedString(content, 36, fixedError)
	if err != nil || !uuidV7Pattern.MatchString(value) {
		return "", fixedError
	}
	return T(value), nil
}

func hasExactKeys(fields map[string]json.RawMessage, keys ...string) bool {
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

func utf16Length(value string) int {
	length := 0
	for _, character := range value {
		if character > 0xffff {
			length += 2
		} else {
			length++
		}
	}
	return length
}
