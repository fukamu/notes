package identity

import (
	"strconv"
	"strings"
)

const (
	SessionCookieName        = "__Host-fukamu_session"
	maximumCookieHeaderBytes = 8_192
	maximumCookieAgeSeconds  = 2_592_000
)

type CookieParseKind string

const (
	CookieMissing CookieParseKind = "missing"
	CookieInvalid CookieParseKind = "invalid"
	CookieFound   CookieParseKind = "found"
)

type CookieParseResult struct {
	Kind  CookieParseKind
	Token SessionToken
}

func ParseSessionCookieHeader(header string) CookieParseResult {
	if header == "" {
		return CookieParseResult{Kind: CookieMissing}
	}
	if len(header) > maximumCookieHeaderBytes {
		return CookieParseResult{Kind: CookieInvalid}
	}
	values := make([]string, 0, 1)
	for _, part := range strings.Split(header, ";") {
		separator := strings.IndexByte(part, '=')
		if separator < 1 || strings.TrimSpace(part[:separator]) != SessionCookieName {
			continue
		}
		values = append(values, strings.TrimSpace(part[separator+1:]))
	}
	if len(values) == 0 {
		return CookieParseResult{Kind: CookieMissing}
	}
	if len(values) != 1 {
		return CookieParseResult{Kind: CookieInvalid}
	}
	token, err := ParseSessionToken(values[0])
	if err != nil {
		return CookieParseResult{Kind: CookieInvalid}
	}
	return CookieParseResult{Kind: CookieFound, Token: token}
}

func SetSessionCookie(token SessionToken, maxAgeSeconds int64) (string, bool) {
	if !validToken(token) || maxAgeSeconds < 1 || maxAgeSeconds > maximumCookieAgeSeconds {
		return "", false
	}
	return serializeSessionCookie(string(token), maxAgeSeconds), true
}

func ClearSessionCookie() string {
	return serializeSessionCookie("", 0)
}

func serializeSessionCookie(value string, maxAgeSeconds int64) string {
	return SessionCookieName + "=" + value + "; Path=/; Max-Age=" +
		strconv.FormatInt(maxAgeSeconds, 10) + "; Secure; HttpOnly; SameSite=Strict"
}
