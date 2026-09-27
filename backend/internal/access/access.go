package access

import (
	"errors"
	"net/url"
	"strings"
	"unicode"
	"unicode/utf8"
)

const MaximumSubjectRunes = 256

var (
	ErrInvalidSubject = errors.New("invalid authenticated subject")
	ErrOriginDenied   = errors.New("request origin denied")
)

type Subject string

func ParseSubject(value string) (Subject, error) {
	if value == "" || value != strings.TrimSpace(value) || !utf8.ValidString(value) {
		return "", ErrInvalidSubject
	}
	count := 0
	for _, character := range value {
		count++
		if unicode.IsControl(character) {
			return "", ErrInvalidSubject
		}
	}
	if count > MaximumSubjectRunes {
		return "", ErrInvalidSubject
	}
	return Subject(value), nil
}

func IsLegacyOwner(subject Subject, owner Subject) bool {
	return subject != "" && owner != "" && subject == owner
}

func RequireSameOrigin(rawOrigin string, publicOrigin *url.URL) error {
	if publicOrigin == nil || rawOrigin == "" {
		return ErrOriginDenied
	}
	origin, err := url.Parse(rawOrigin)
	if err != nil || origin.Scheme == "" || origin.Host == "" || origin.User != nil ||
		origin.Path != "" || origin.RawQuery != "" || origin.Fragment != "" {
		return ErrOriginDenied
	}
	if origin.Scheme != publicOrigin.Scheme || origin.Host != publicOrigin.Host {
		return ErrOriginDenied
	}
	return nil
}
