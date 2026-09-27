package legal

import (
	"bytes"
	"encoding/json"
	"io"
)

func SerializeTermsDisclosure(disclosure TermsDisclosure) (string, error) {
	if !ValidTermsDisclosure(disclosure) {
		return "", ErrInvalidTermsValue
	}
	encoded, err := marshalJavaScriptJSON(disclosure)
	if err != nil {
		return "", ErrInvalidTermsValue
	}
	return string(encoded), nil
}

func DecodeTermsDisclosure(encoded []byte) (TermsDisclosure, error) {
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.DisallowUnknownFields()
	var disclosure TermsDisclosure
	if err := decoder.Decode(&disclosure); err != nil {
		return TermsDisclosure{}, ErrInvalidTermsValue
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF || !ValidTermsDisclosure(disclosure) {
		return TermsDisclosure{}, ErrInvalidTermsValue
	}
	return cloneTermsDisclosure(disclosure), nil
}

func cloneTermsDisclosure(value TermsDisclosure) TermsDisclosure {
	cloned := value
	cloned.ProhibitedActivities = append([]string(nil), value.ProhibitedActivities...)
	return cloned
}

func marshalJavaScriptJSON(value any) ([]byte, error) {
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
