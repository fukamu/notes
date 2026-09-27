package telemetry

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"math"
	"strconv"
	"unicode/utf8"
)

const MaximumEventBytes = 4_096

var ErrInvalidEvent = errors.New("invalid telemetry event")

// DecodeEventJSON is the untrusted-data boundary for persisted or transported
// events. It returns one fixed error and never reflects rejected content.
func DecodeEventJSON(content []byte) (Event, error) {
	fields, err := decodeEventObject(content)
	if err != nil || !hasExactEventKeys(fields) {
		return Event{}, ErrInvalidEvent
	}
	schemaVersion, err := decodeEventInteger(fields["schemaVersion"])
	if err != nil || schemaVersion != SchemaVersion {
		return Event{}, ErrInvalidEvent
	}
	operation, operationErr := decodeEventString(fields["operation"])
	outcome, outcomeErr := decodeEventString(fields["outcome"])
	failure, failureErr := decodeEventString(fields["failureCategory"])
	duration, durationErr := decodeEventString(fields["durationBucket"])
	workItems, workItemsErr := decodeEventString(fields["workItemsBucket"])
	if operationErr != nil || outcomeErr != nil || failureErr != nil || durationErr != nil || workItemsErr != nil {
		return Event{}, ErrInvalidEvent
	}
	plan := PlanEvent(EventInput{
		Operation: Operation(operation), Outcome: Outcome(outcome), FailureCategory: FailureCategory(failure),
		DurationBucket: DurationBucket(duration), WorkItemsBucket: CountBucket(workItems),
	})
	accepted, ok := plan.(AcceptedEvent)
	if !ok {
		return Event{}, ErrInvalidEvent
	}
	return accepted.Event(), nil
}

func decodeEventObject(content []byte) (map[string]json.RawMessage, error) {
	if len(content) == 0 || len(content) > MaximumEventBytes || !utf8.Valid(content) ||
		!validEventSurrogateEscapes(content) {
		return nil, ErrInvalidEvent
	}
	decoder := json.NewDecoder(bytes.NewReader(content))
	opening, err := decoder.Token()
	if err != nil || opening != json.Delim('{') {
		return nil, ErrInvalidEvent
	}
	fields := make(map[string]json.RawMessage, 6)
	for decoder.More() {
		keyToken, err := decoder.Token()
		key, ok := keyToken.(string)
		if err != nil || !ok {
			return nil, ErrInvalidEvent
		}
		if _, duplicate := fields[key]; duplicate {
			return nil, ErrInvalidEvent
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return nil, ErrInvalidEvent
		}
		fields[key] = value
	}
	closing, err := decoder.Token()
	if err != nil || closing != json.Delim('}') || !eventDecoderAtEnd(decoder) {
		return nil, ErrInvalidEvent
	}
	return fields, nil
}

func decodeEventInteger(content []byte) (int64, error) {
	decoder := json.NewDecoder(bytes.NewReader(content))
	decoder.UseNumber()
	var raw any
	if err := decoder.Decode(&raw); err != nil || !eventDecoderAtEnd(decoder) {
		return 0, ErrInvalidEvent
	}
	number, ok := raw.(json.Number)
	if !ok {
		return 0, ErrInvalidEvent
	}
	parsed, err := strconv.ParseFloat(string(number), 64)
	if err != nil || math.IsInf(parsed, 0) || math.IsNaN(parsed) || math.Trunc(parsed) != parsed ||
		parsed < 0 || parsed > MaximumSafeIntegerCount {
		return 0, ErrInvalidEvent
	}
	return int64(parsed), nil
}

func decodeEventString(content []byte) (string, error) {
	if !utf8.Valid(content) || !validEventSurrogateEscapes(content) {
		return "", ErrInvalidEvent
	}
	var value string
	decoder := json.NewDecoder(bytes.NewReader(content))
	if err := decoder.Decode(&value); err != nil || !eventDecoderAtEnd(decoder) || !utf8.ValidString(value) {
		return "", ErrInvalidEvent
	}
	return value, nil
}

func hasExactEventKeys(fields map[string]json.RawMessage) bool {
	if len(fields) != 6 {
		return false
	}
	for _, key := range [...]string{
		"schemaVersion", "operation", "outcome", "failureCategory", "durationBucket", "workItemsBucket",
	} {
		if _, ok := fields[key]; !ok {
			return false
		}
	}
	return true
}

func eventDecoderAtEnd(decoder *json.Decoder) bool {
	var extra any
	return errors.Is(decoder.Decode(&extra), io.EOF)
}

func validEventSurrogateEscapes(content []byte) bool {
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
		codeUnit, ok := decodeEventHexCodeUnit(content, index+1)
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
			low, ok := decodeEventHexCodeUnit(content, index+3)
			if !ok || low < 0xdc00 || low > 0xdfff {
				return false
			}
			index += 6
		}
	}
	return true
}

func decodeEventHexCodeUnit(content []byte, start int) (uint64, bool) {
	if start+4 > len(content) {
		return 0, false
	}
	value, err := strconv.ParseUint(string(content[start:start+4]), 16, 16)
	return value, err == nil
}
