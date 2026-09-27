package syncv2

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

var cursorPattern = regexp.MustCompile(`^[A-Za-z0-9._~-]+$`)

func DecodeRequest(content []byte) (Request, error) {
	if len(content) == 0 || len(content) > MaximumRequestBytes || !utf8.Valid(content) {
		return Request{}, ErrInvalidRequest
	}
	fields, err := decodeJSONObject(content, ErrInvalidRequest)
	if err != nil || !hasExactJSONKeys(fields, "version", "deviceId", "cursor", "mutations") {
		return Request{}, ErrInvalidRequest
	}
	version, err := decodeBoundedJSONString(fields["version"], len(ProtocolVersion), ErrInvalidRequest)
	if err != nil || version != ProtocolVersion {
		return Request{}, ErrInvalidRequest
	}
	deviceID, err := decodeUUID[DeviceID](fields["deviceId"], ErrInvalidRequest)
	if err != nil {
		return Request{}, ErrInvalidRequest
	}
	var cursor *Cursor
	if !bytes.Equal(bytes.TrimSpace(fields["cursor"]), []byte("null")) {
		decoded, err := decodeCursor(fields["cursor"])
		if err != nil {
			return Request{}, ErrInvalidRequest
		}
		cursor = &decoded
	}
	items, err := decodeJSONArray(fields["mutations"], MaximumMutations, ErrInvalidRequest)
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
	return Request{DeviceID: deviceID, Cursor: cursor, Mutations: mutations}, nil
}

func decodeMutation(content json.RawMessage) (Mutation, error) {
	fields, err := decodeJSONObject(content, ErrInvalidRequest)
	if err != nil || !hasExactJSONKeys(fields,
		"mutationId", "cardId", "baseServerRevision", "title", "body",
		"createdAt", "updatedAt", "kind", "conflictIds",
	) {
		return Mutation{}, ErrInvalidRequest
	}
	mutationID, err := decodeUUID[MutationID](fields["mutationId"], ErrInvalidRequest)
	if err != nil {
		return Mutation{}, ErrInvalidRequest
	}
	cardID, err := decodeUUID[CardID](fields["cardId"], ErrInvalidRequest)
	if err != nil {
		return Mutation{}, ErrInvalidRequest
	}
	title, err := decodeBoundedJSONString(fields["title"], MaximumTitleCharacters, ErrInvalidRequest)
	if err != nil {
		return Mutation{}, ErrInvalidRequest
	}
	body, err := decodeBody(fields["body"], ErrInvalidRequest)
	if err != nil {
		return Mutation{}, ErrInvalidRequest
	}
	createdAt, err := decodeSafeJSONInteger(fields["createdAt"], false, ErrInvalidRequest)
	if err != nil {
		return Mutation{}, ErrInvalidRequest
	}
	updatedAt, err := decodeSafeJSONInteger(fields["updatedAt"], false, ErrInvalidRequest)
	if err != nil || createdAt > updatedAt {
		return Mutation{}, ErrInvalidRequest
	}
	kindValue, err := decodeBoundedJSONString(fields["kind"], 16, ErrInvalidRequest)
	if err != nil {
		return Mutation{}, ErrInvalidRequest
	}
	conflictItems, err := decodeJSONArray(fields["conflictIds"], MaximumConflictIDs, ErrInvalidRequest)
	if err != nil {
		return Mutation{}, ErrInvalidRequest
	}
	conflictIDs := make([]ConflictID, 0, len(conflictItems))
	seenConflicts := make(map[ConflictID]struct{}, len(conflictItems))
	for _, item := range conflictItems {
		identifier, err := decodeUUID[ConflictID](item, ErrInvalidRequest)
		if err != nil {
			return Mutation{}, ErrInvalidRequest
		}
		if _, duplicate := seenConflicts[identifier]; duplicate {
			return Mutation{}, ErrInvalidRequest
		}
		seenConflicts[identifier] = struct{}{}
		conflictIDs = append(conflictIDs, identifier)
	}
	var baseRevision *Revision
	if !bytes.Equal(bytes.TrimSpace(fields["baseServerRevision"]), []byte("null")) {
		value, err := decodeSafeJSONInteger(fields["baseServerRevision"], true, ErrInvalidRequest)
		if err != nil || value > MaximumRevision {
			return Mutation{}, ErrInvalidRequest
		}
		parsed := Revision(value)
		baseRevision = &parsed
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
		MutationID: mutationID, CardID: cardID, BaseServerRevision: baseRevision,
		Title: title, Body: body, CreatedAt: createdAt, UpdatedAt: updatedAt,
		Kind: kind, ConflictIDs: conflictIDs,
	}, nil
}

func DecodeStoredCard(content []byte) (StoredCard, error) {
	fields, err := decodeJSONObject(content, ErrInvalidStoredContent)
	if err != nil || !hasExactJSONKeys(fields, "title", "body", "createdAt", "updatedAt") {
		return StoredCard{}, ErrInvalidStoredContent
	}
	title, err := decodeBoundedJSONString(fields["title"], MaximumTitleCharacters, ErrInvalidStoredContent)
	if err != nil {
		return StoredCard{}, ErrInvalidStoredContent
	}
	body, err := decodeBody(fields["body"], ErrInvalidStoredContent)
	if err != nil {
		return StoredCard{}, ErrInvalidStoredContent
	}
	createdAt, err := decodeSafeJSONInteger(fields["createdAt"], false, ErrInvalidStoredContent)
	if err != nil {
		return StoredCard{}, ErrInvalidStoredContent
	}
	updatedAt, err := decodeSafeJSONInteger(fields["updatedAt"], false, ErrInvalidStoredContent)
	if err != nil || createdAt > updatedAt {
		return StoredCard{}, ErrInvalidStoredContent
	}
	return StoredCard{Title: title, Body: body, CreatedAt: createdAt, UpdatedAt: updatedAt}, nil
}

func DecodeStoredConflict(content []byte) (StoredConflict, error) {
	fields, err := decodeJSONObject(content, ErrInvalidStoredContent)
	if err != nil || !hasExactJSONKeys(
		fields, "localTitle", "localBody", "serverTitle", "serverBody", "createdAt",
	) {
		return StoredConflict{}, ErrInvalidStoredContent
	}
	localTitle, err := decodeBoundedJSONString(fields["localTitle"], MaximumTitleCharacters, ErrInvalidStoredContent)
	if err != nil {
		return StoredConflict{}, ErrInvalidStoredContent
	}
	localBody, err := decodeBody(fields["localBody"], ErrInvalidStoredContent)
	if err != nil {
		return StoredConflict{}, ErrInvalidStoredContent
	}
	serverTitle, err := decodeBoundedJSONString(fields["serverTitle"], MaximumTitleCharacters, ErrInvalidStoredContent)
	if err != nil {
		return StoredConflict{}, ErrInvalidStoredContent
	}
	serverBody, err := decodeBody(fields["serverBody"], ErrInvalidStoredContent)
	if err != nil {
		return StoredConflict{}, ErrInvalidStoredContent
	}
	createdAt, err := decodeSafeJSONInteger(fields["createdAt"], false, ErrInvalidStoredContent)
	if err != nil {
		return StoredConflict{}, ErrInvalidStoredContent
	}
	return StoredConflict{
		LocalTitle: localTitle, LocalBody: localBody, ServerTitle: serverTitle,
		ServerBody: serverBody, CreatedAt: createdAt,
	}, nil
}

func EncodeStoredCard(content StoredCard) ([]byte, error) {
	if !validStoredCard(content) {
		return nil, ErrInvalidStoredContent
	}
	return marshalCanonical(content)
}

func EncodeStoredConflict(content StoredConflict) ([]byte, error) {
	if !validStoredConflict(content) {
		return nil, ErrInvalidStoredContent
	}
	return marshalCanonical(content)
}

func ValidateResponse(response Response) error {
	if response.Version != ProtocolVersion || response.HighWatermark < 0 ||
		len(response.Changes) > MaximumPageSize || len(response.Receipts) > MaximumMutations ||
		(response.Page.Kind != PageMore && response.Page.Kind != PageComplete) ||
		!validCursor(response.Page.NextCursor) || response.Changes == nil || response.Receipts == nil {
		return ErrInvalidResponse
	}
	seenSequences := make(map[Sequence]struct{}, len(response.Changes))
	previous := Sequence(0)
	for _, change := range response.Changes {
		if !validHydratedChange(change) || change.Sequence <= previous ||
			change.Sequence > response.HighWatermark {
			return ErrInvalidResponse
		}
		if _, duplicate := seenSequences[change.Sequence]; duplicate {
			return ErrInvalidResponse
		}
		seenSequences[change.Sequence] = struct{}{}
		previous = change.Sequence
	}
	seenReceipts := make(map[MutationID]struct{}, len(response.Receipts))
	for _, receipt := range response.Receipts {
		if _, err := ParseMutationID(string(receipt.MutationID)); err != nil {
			return ErrInvalidResponse
		}
		if _, err := ParseCardID(string(receipt.CardID)); err != nil {
			return ErrInvalidResponse
		}
		if _, err := ParseRevision(int64(receipt.AppliedRevision)); err != nil {
			return ErrInvalidResponse
		}
		if _, duplicate := seenReceipts[receipt.MutationID]; duplicate {
			return ErrInvalidResponse
		}
		seenReceipts[receipt.MutationID] = struct{}{}
	}
	return nil
}

func validHydratedChange(change HydratedChange) bool {
	if change.Sequence < 1 {
		return false
	}
	switch change.Kind {
	case ChangeCardUpsert:
		return change.Card != nil && change.Conflict == nil && validServerCard(*change.Card)
	case ChangeConflictUpsert:
		return change.Card == nil && change.Conflict != nil && validServerConflict(*change.Conflict)
	case ChangeCardTombstone:
		_, cardErr := ParseCardID(string(change.CardID))
		_, revisionErr := ParseRevision(int64(change.Revision))
		return change.Card == nil && change.Conflict == nil && change.ConflictID == "" &&
			cardErr == nil && revisionErr == nil && validTimestamp(change.OccurredAt)
	case ChangeConflictTombstone:
		_, cardErr := ParseCardID(string(change.CardID))
		_, conflictErr := ParseConflictID(string(change.ConflictID))
		return change.Card == nil && change.Conflict == nil && change.Revision == 0 &&
			cardErr == nil && conflictErr == nil && validTimestamp(change.OccurredAt)
	default:
		return false
	}
}

func validServerCard(card ServerCard) bool {
	_, cardErr := ParseCardID(string(card.ID))
	_, revisionErr := ParseRevision(int64(card.Revision))
	return cardErr == nil && revisionErr == nil && card.OfficialDisplayID >= 1 &&
		card.OfficialDisplayID <= MaximumDisplayID && validStoredCard(StoredCard{
		Title: card.Title, Body: card.Body, CreatedAt: card.CreatedAt, UpdatedAt: card.UpdatedAt,
	})
}

func validServerConflict(conflict ServerConflict) bool {
	_, cardErr := ParseCardID(string(conflict.CardID))
	_, conflictErr := ParseConflictID(string(conflict.ID))
	_, revisionErr := ParseRevision(int64(conflict.ServerRevision))
	return cardErr == nil && conflictErr == nil && revisionErr == nil &&
		validStoredConflict(StoredConflict{
			LocalTitle: conflict.LocalTitle, LocalBody: conflict.LocalBody,
			ServerTitle: conflict.ServerTitle, ServerBody: conflict.ServerBody,
			CreatedAt: conflict.CreatedAt,
		})
}

func validStoredCard(card StoredCard) bool {
	return validBoundedString(card.Title, MaximumTitleCharacters) && validBody(card.Body) &&
		validTimestamp(card.CreatedAt) && validTimestamp(card.UpdatedAt) && card.CreatedAt <= card.UpdatedAt
}

func validStoredConflict(conflict StoredConflict) bool {
	return validBoundedString(conflict.LocalTitle, MaximumTitleCharacters) && validBody(conflict.LocalBody) &&
		validBoundedString(conflict.ServerTitle, MaximumTitleCharacters) && validBody(conflict.ServerBody) &&
		validTimestamp(conflict.CreatedAt)
}

func validBody(body []BodySegment) bool {
	if body == nil || len(body) > MaximumBodySegments {
		return false
	}
	for _, segment := range body {
		switch segment.Kind {
		case SegmentText:
			if segment.TargetCardID != "" || !validBoundedString(segment.Text, MaximumTextCharacters) {
				return false
			}
		case SegmentLink:
			if segment.Text != "" {
				return false
			}
			if _, err := ParseCardID(string(segment.TargetCardID)); err != nil {
				return false
			}
		default:
			return false
		}
	}
	return true
}

func decodeBody(content json.RawMessage, fixedError error) ([]BodySegment, error) {
	items, err := decodeJSONArray(content, MaximumBodySegments, fixedError)
	if err != nil {
		return nil, fixedError
	}
	segments := make([]BodySegment, 0, len(items))
	for _, item := range items {
		fields, err := decodeJSONObject(item, fixedError)
		if err != nil {
			return nil, fixedError
		}
		kind, err := decodeBoundedJSONString(fields["type"], 16, fixedError)
		if err != nil {
			return nil, fixedError
		}
		switch SegmentKind(kind) {
		case SegmentText:
			if !hasExactJSONKeys(fields, "type", "text") {
				return nil, fixedError
			}
			text, err := decodeBoundedJSONString(fields["text"], MaximumTextCharacters, fixedError)
			if err != nil {
				return nil, fixedError
			}
			segments = append(segments, BodySegment{Kind: SegmentText, Text: text})
		case SegmentLink:
			if !hasExactJSONKeys(fields, "type", "targetCardId") {
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

func decodeCursor(content []byte) (Cursor, error) {
	value, err := decodeBoundedJSONString(content, MaximumCursorCharacters, ErrInvalidCursor)
	if err != nil || len(value) < 24 || !cursorPattern.MatchString(value) {
		return "", ErrInvalidCursor
	}
	return Cursor(value), nil
}

func validCursor(value Cursor) bool {
	return len(value) >= 24 && utf16Length(string(value)) <= MaximumCursorCharacters &&
		cursorPattern.MatchString(string(value))
}

func decodeJSONObject(content []byte, fixedError error) (map[string]json.RawMessage, error) {
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
	if err != nil || closing != json.Delim('}') || !jsonDecoderAtEnd(decoder) {
		return nil, fixedError
	}
	return fields, nil
}

func decodeJSONArray(content []byte, maximum int, fixedError error) ([]json.RawMessage, error) {
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
	if err != nil || closing != json.Delim(']') || !jsonDecoderAtEnd(decoder) {
		return nil, fixedError
	}
	return values, nil
}

func decodeBoundedJSONString(content []byte, maximum int, fixedError error) (string, error) {
	if !validJSONSurrogateEscapes(content) {
		return "", fixedError
	}
	var value string
	decoder := json.NewDecoder(bytes.NewReader(content))
	if err := decoder.Decode(&value); err != nil || !jsonDecoderAtEnd(decoder) ||
		!validBoundedString(value, maximum) {
		return "", fixedError
	}
	return value, nil
}

func validBoundedString(value string, maximum int) bool {
	return utf8.ValidString(value) && utf16Length(value) <= maximum
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

func decodeSafeJSONInteger(content []byte, positive bool, fixedError error) (int64, error) {
	decoder := json.NewDecoder(bytes.NewReader(content))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err != nil || !jsonDecoderAtEnd(decoder) {
		return 0, fixedError
	}
	number, ok := value.(json.Number)
	if !ok {
		return 0, fixedError
	}
	parsed, err := strconv.ParseFloat(string(number), 64)
	if err != nil || math.IsInf(parsed, 0) || math.IsNaN(parsed) || math.Trunc(parsed) != parsed ||
		parsed < 0 || parsed > float64(MaximumSafeInteger) || positive && parsed < 1 {
		return 0, fixedError
	}
	return int64(parsed), nil
}

func decodeUUID[T ~string](content []byte, fixedError error) (T, error) {
	value, err := decodeBoundedJSONString(content, 36, fixedError)
	if err != nil || !uuidV7Pattern.MatchString(value) {
		return "", fixedError
	}
	return T(value), nil
}

func hasExactJSONKeys(fields map[string]json.RawMessage, keys ...string) bool {
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

func jsonDecoderAtEnd(decoder *json.Decoder) bool {
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
