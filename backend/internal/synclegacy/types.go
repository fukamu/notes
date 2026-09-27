package synclegacy

import (
	"bytes"
	"encoding/json"
	"errors"
	"unicode/utf8"
)

const (
	MaximumBodySegments   = 10_000
	MaximumCards          = 100_000
	MaximumConflictIDs    = 500
	MaximumConflicts      = 100_000
	MaximumMutations      = 500
	MaximumPayloadBytes   = 4_000_000
	MaximumSerializedBody = 2_000_000
	MaximumTextLength     = 100_000
	MaximumTitleLength    = 10_000
	MaximumSafeInteger    = int64(9_007_199_254_740_991)
)

var (
	ErrInvalidRequest = errors.New("invalid legacy sync request")
	ErrInvalidState   = errors.New("invalid legacy sync state")
	ErrSyncFailed     = errors.New("legacy sync failed")
)

type CardID string
type MutationID string
type ConflictID string
type DeviceID string

type SegmentKind string

const (
	SegmentText SegmentKind = "text"
	SegmentLink SegmentKind = "link"
)

type BodySegment struct {
	Kind         SegmentKind
	Text         string
	TargetCardID CardID
}

func (segment BodySegment) MarshalJSON() ([]byte, error) {
	switch segment.Kind {
	case SegmentText:
		return marshalWithoutHTMLEscape(struct {
			Type string `json:"type"`
			Text string `json:"text"`
		}{Type: string(SegmentText), Text: segment.Text})
	case SegmentLink:
		return marshalWithoutHTMLEscape(struct {
			Type         string `json:"type"`
			TargetCardID CardID `json:"targetCardId"`
		}{Type: string(SegmentLink), TargetCardID: segment.TargetCardID})
	default:
		return nil, ErrInvalidState
	}
}

func marshalWithoutHTMLEscape(value any) ([]byte, error) {
	var output bytes.Buffer
	encoder := json.NewEncoder(&output)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	return bytes.TrimSuffix(output.Bytes(), []byte{'\n'}), nil
}

type MutationKind string

const (
	MutationUpsert  MutationKind = "upsert"
	MutationResolve MutationKind = "resolve"
)

type Mutation struct {
	MutationID         MutationID
	CardID             CardID
	BaseServerRevision *int64
	Title              string
	Body               []BodySegment
	CreatedAt          int64
	UpdatedAt          int64
	Kind               MutationKind
	ConflictIDs        []ConflictID
}

type Request struct {
	DeviceID  DeviceID
	Mutations []Mutation
}

type Card struct {
	ID                CardID        `json:"id"`
	OfficialDisplayID int64         `json:"officialDisplayId"`
	Title             string        `json:"title"`
	Body              []BodySegment `json:"body"`
	CreatedAt         int64         `json:"createdAt"`
	UpdatedAt         int64         `json:"updatedAt"`
	Revision          int64         `json:"revision"`
}

type Conflict struct {
	ID             ConflictID    `json:"id"`
	CardID         CardID        `json:"cardId"`
	ServerRevision int64         `json:"serverRevision"`
	LocalTitle     string        `json:"localTitle"`
	LocalBody      []BodySegment `json:"localBody"`
	ServerTitle    string        `json:"serverTitle"`
	ServerBody     []BodySegment `json:"serverBody"`
	CreatedAt      int64         `json:"createdAt"`
}

type Response struct {
	Cards                   []Card       `json:"cards"`
	Conflicts               []Conflict   `json:"conflicts"`
	AcknowledgedMutationIDs []MutationID `json:"acknowledgedMutationIds"`
}

func EncodeBody(body []BodySegment) (string, error) {
	if err := validateBody(body, ErrInvalidState); err != nil {
		return "", err
	}
	var output bytes.Buffer
	encoder := json.NewEncoder(&output)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(body); err != nil {
		return "", ErrInvalidState
	}
	encoded := bytes.TrimSuffix(output.Bytes(), []byte{'\n'})
	encoded = unescapeJSONLineSeparators(encoded)
	if utf16Length(string(encoded)) > MaximumSerializedBody {
		return "", ErrInvalidState
	}
	return string(encoded), nil
}

func unescapeJSONLineSeparators(encoded []byte) []byte {
	output := make([]byte, 0, len(encoded))
	for index := 0; index < len(encoded); {
		if encoded[index] != '\\' {
			output = append(output, encoded[index])
			index++
			continue
		}
		runEnd := index
		for runEnd < len(encoded) && encoded[runEnd] == '\\' {
			runEnd++
		}
		if (runEnd-index)%2 == 1 && runEnd+5 <= len(encoded) && encoded[runEnd] == 'u' &&
			(string(encoded[runEnd+1:runEnd+5]) == "2028" ||
				string(encoded[runEnd+1:runEnd+5]) == "2029") {
			output = append(output, encoded[index:runEnd-1]...)
			if encoded[runEnd+4] == '8' {
				output = append(output, '\xe2', '\x80', '\xa8')
			} else {
				output = append(output, '\xe2', '\x80', '\xa9')
			}
			index = runEnd + 5
			continue
		}
		output = append(output, encoded[index:runEnd]...)
		index = runEnd
	}
	return output
}

func DecodeStoredBody(value string) ([]BodySegment, error) {
	if !utf8.ValidString(value) || utf16Length(value) > MaximumSerializedBody {
		return nil, ErrInvalidState
	}
	body, err := decodeBody(json.RawMessage(value), ErrInvalidState)
	if err != nil {
		return nil, ErrInvalidState
	}
	return body, nil
}

func DecodeStoredMutationID(value string) (MutationID, error) {
	if !validUUID(value) {
		return "", ErrInvalidState
	}
	return MutationID(value), nil
}
