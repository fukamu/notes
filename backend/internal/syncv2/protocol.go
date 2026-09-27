package syncv2

import (
	"bytes"
	"encoding/json"
	"errors"
)

const (
	ProtocolVersion          = "sync/v2"
	CursorVersion            = "sync-cursor/v2"
	MaximumCursorCharacters  = 2_048
	MaximumMutations         = 500
	MaximumBodySegments      = 10_000
	MaximumTitleCharacters   = 10_000
	MaximumTextCharacters    = 100_000
	MaximumRequestBytes      = 4_000_000
	MaximumCursorSecretBytes = 128
	MinimumCursorSecretBytes = 32
)

var (
	ErrInvalidRequest       = errors.New("invalid Sync v2 request")
	ErrInvalidStoredContent = errors.New("invalid Sync v2 stored content")
	ErrInvalidCursor        = errors.New("invalid Sync v2 cursor")
	ErrInvalidResponse      = errors.New("invalid Sync v2 response")
)

type DeviceID string
type Cursor string

type SegmentKind string

const (
	SegmentText SegmentKind = "text"
	SegmentLink SegmentKind = "link"
)

// BodySegment is a validated tagged value. Text is populated only for text
// segments and TargetCardID only for link segments.
type BodySegment struct {
	Kind         SegmentKind
	Text         string
	TargetCardID CardID
}

func (segment BodySegment) MarshalJSON() ([]byte, error) {
	switch segment.Kind {
	case SegmentText:
		return marshalCanonical(struct {
			Type string `json:"type"`
			Text string `json:"text"`
		}{Type: string(SegmentText), Text: segment.Text})
	case SegmentLink:
		return marshalCanonical(struct {
			Type         string `json:"type"`
			TargetCardID CardID `json:"targetCardId"`
		}{Type: string(SegmentLink), TargetCardID: segment.TargetCardID})
	default:
		return nil, ErrInvalidStoredContent
	}
}

type MutationKind string

const (
	MutationUpsert  MutationKind = "upsert"
	MutationResolve MutationKind = "resolve"
)

type Mutation struct {
	MutationID         MutationID
	CardID             CardID
	BaseServerRevision *Revision
	Title              string
	Body               []BodySegment
	CreatedAt          int64
	UpdatedAt          int64
	Kind               MutationKind
	ConflictIDs        []ConflictID
}

type Request struct {
	DeviceID  DeviceID
	Cursor    *Cursor
	Mutations []Mutation
}

type StoredCard struct {
	Title     string        `json:"title"`
	Body      []BodySegment `json:"body"`
	CreatedAt int64         `json:"createdAt"`
	UpdatedAt int64         `json:"updatedAt"`
}

type StoredConflict struct {
	LocalTitle  string        `json:"localTitle"`
	LocalBody   []BodySegment `json:"localBody"`
	ServerTitle string        `json:"serverTitle"`
	ServerBody  []BodySegment `json:"serverBody"`
	CreatedAt   int64         `json:"createdAt"`
}

type ServerCard struct {
	ID                CardID        `json:"id"`
	OfficialDisplayID int64         `json:"officialDisplayId"`
	Title             string        `json:"title"`
	Body              []BodySegment `json:"body"`
	CreatedAt         int64         `json:"createdAt"`
	UpdatedAt         int64         `json:"updatedAt"`
	Revision          Revision      `json:"revision"`
}

type ServerConflict struct {
	ID             ConflictID    `json:"id"`
	CardID         CardID        `json:"cardId"`
	ServerRevision Revision      `json:"serverRevision"`
	LocalTitle     string        `json:"localTitle"`
	LocalBody      []BodySegment `json:"localBody"`
	ServerTitle    string        `json:"serverTitle"`
	ServerBody     []BodySegment `json:"serverBody"`
	CreatedAt      int64         `json:"createdAt"`
}

// HydratedChange is the public Sync v2 change. Journal metadata is hydrated
// from the exact immutable encrypted-object revision before it reaches JSON.
type HydratedChange struct {
	Kind       ChangeKind
	Sequence   Sequence
	Card       *ServerCard
	Conflict   *ServerConflict
	CardID     CardID
	ConflictID ConflictID
	Revision   Revision
	OccurredAt int64
}

func (change HydratedChange) MarshalJSON() ([]byte, error) {
	switch change.Kind {
	case ChangeCardUpsert:
		if change.Card == nil {
			return nil, ErrInvalidResponse
		}
		return marshalCanonical(struct {
			Kind     ChangeKind `json:"kind"`
			Sequence Sequence   `json:"sequence"`
			Card     ServerCard `json:"card"`
		}{Kind: change.Kind, Sequence: change.Sequence, Card: *change.Card})
	case ChangeConflictUpsert:
		if change.Conflict == nil {
			return nil, ErrInvalidResponse
		}
		return marshalCanonical(struct {
			Kind     ChangeKind     `json:"kind"`
			Sequence Sequence       `json:"sequence"`
			Conflict ServerConflict `json:"conflict"`
		}{Kind: change.Kind, Sequence: change.Sequence, Conflict: *change.Conflict})
	case ChangeCardTombstone:
		return marshalCanonical(struct {
			Kind      ChangeKind `json:"kind"`
			Sequence  Sequence   `json:"sequence"`
			CardID    CardID     `json:"cardId"`
			Revision  Revision   `json:"revision"`
			DeletedAt int64      `json:"deletedAt"`
		}{change.Kind, change.Sequence, change.CardID, change.Revision, change.OccurredAt})
	case ChangeConflictTombstone:
		return marshalCanonical(struct {
			Kind       ChangeKind `json:"kind"`
			Sequence   Sequence   `json:"sequence"`
			ConflictID ConflictID `json:"conflictId"`
			CardID     CardID     `json:"cardId"`
			DeletedAt  int64      `json:"deletedAt"`
		}{change.Kind, change.Sequence, change.ConflictID, change.CardID, change.OccurredAt})
	default:
		return nil, ErrInvalidResponse
	}
}

type MutationReceipt struct {
	MutationID      MutationID `json:"mutationId"`
	CardID          CardID     `json:"cardId"`
	AppliedRevision Revision   `json:"appliedRevision"`
}

type ResponsePage struct {
	Kind       PageKind `json:"kind"`
	NextCursor Cursor   `json:"nextCursor"`
}

type Response struct {
	Version       string            `json:"version"`
	HighWatermark Sequence          `json:"highWatermark"`
	Changes       []HydratedChange  `json:"changes"`
	Receipts      []MutationReceipt `json:"receipts"`
	Page          ResponsePage      `json:"page"`
}

func EncodeResponse(response Response) ([]byte, error) {
	if err := ValidateResponse(response); err != nil {
		return nil, err
	}
	return marshalCanonical(response)
}

func marshalCanonical(value any) ([]byte, error) {
	var output bytes.Buffer
	encoder := json.NewEncoder(&output)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		return nil, err
	}
	encoded := bytes.TrimSuffix(output.Bytes(), []byte{'\n'})
	return unescapeJSONLineSeparators(encoded), nil
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
			(string(encoded[runEnd+1:runEnd+5]) == "2028" || string(encoded[runEnd+1:runEnd+5]) == "2029") {
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
