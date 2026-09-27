package objectstorage

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"regexp"
	"sort"
	"strconv"
	"strings"

	"github.com/fukamu/notes/backend/internal/encryptedobject"
)

const (
	gcsEndpoint             = "https://storage.googleapis.com"
	gcsObjectPrefix         = "objects/"
	gcsCreatedAtMetadataKey = "fukamuCreatedAtMillis"
	gcsMaximumResponseBytes = 4 * 1024 * 1024
	gcsMaximumListPages     = 1_000
)

var (
	ErrGCSConfiguration = errors.New("GCS private object storage configuration is unavailable")
	ErrGCSOperation     = errors.New("GCS private object storage operation failed")
	gcsBucketPattern    = regexp.MustCompile(`^[a-z0-9][a-z0-9._-]{1,61}[a-z0-9]$`)
)

type GCSAccessTokenSource interface {
	ReadAccessToken(context.Context) (string, error)
}

type GCSHTTPDoer interface {
	Do(*http.Request) (*http.Response, error)
}

// GCS stores only opaque envelope ciphertext beneath a fixed private prefix.
// Bucket ACL/IAM remains an infrastructure concern; this adapter never makes
// an object public and never accepts a caller-controlled bucket or prefix.
type GCS struct {
	bucket      string
	accessToken GCSAccessTokenSource
	client      GCSHTTPDoer
	endpoint    string
}

var _ encryptedobject.ObjectStoragePort = (*GCS)(nil)

func NewGCS(bucket string, accessToken GCSAccessTokenSource, client GCSHTTPDoer) (*GCS, error) {
	return newGCS(bucket, accessToken, client, gcsEndpoint)
}

func newGCS(
	bucket string,
	accessToken GCSAccessTokenSource,
	client GCSHTTPDoer,
	endpoint string,
) (*GCS, error) {
	if !validGCSBucket(bucket) || accessToken == nil || client == nil || endpoint == "" ||
		strings.HasSuffix(endpoint, "/") {
		return nil, ErrGCSConfiguration
	}
	parsed, err := url.Parse(endpoint)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" || parsed.User != nil ||
		parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, ErrGCSConfiguration
	}
	return &GCS{bucket: bucket, accessToken: accessToken, client: client, endpoint: endpoint}, nil
}

func (storage *GCS) Get(
	ctx context.Context,
	objectKey encryptedobject.ObjectKey,
) ([]byte, bool, error) {
	objectName, err := storage.objectName(ctx, objectKey)
	if err != nil {
		return nil, false, err
	}
	requestURL := storage.endpoint + "/storage/v1/b/" + storage.bucket + "/o/" +
		url.PathEscape(objectName) + "?alt=media"
	response, err := storage.request(ctx, http.MethodGet, requestURL, nil, "")
	if err != nil {
		return nil, false, err
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusNotFound {
		drainGCSResponse(response.Body)
		return nil, false, nil
	}
	if response.StatusCode != http.StatusOK {
		drainGCSResponse(response.Body)
		return nil, false, ErrGCSOperation
	}
	value, err := io.ReadAll(io.LimitReader(response.Body, encryptedobject.MaximumStoredBytes+1))
	if err != nil || int64(len(value)) > encryptedobject.MaximumStoredBytes {
		clear(value)
		return nil, false, ErrGCSOperation
	}
	return value, true, nil
}

func (storage *GCS) PutIfAbsent(
	ctx context.Context,
	objectKey encryptedobject.ObjectKey,
	value []byte,
	createdAtMilli int64,
) (encryptedobject.PutResult, error) {
	objectName, err := storage.objectName(ctx, objectKey)
	if err != nil || createdAtMilli < 0 || createdAtMilli > 9_007_199_254_740_991 ||
		int64(len(value)) > encryptedobject.MaximumStoredBytes {
		return "", ErrGCSOperation
	}
	body, contentType, err := gcsMultipartObject(objectName, value, createdAtMilli)
	if err != nil {
		return "", ErrGCSOperation
	}
	requestURL := storage.endpoint + "/upload/storage/v1/b/" + storage.bucket +
		"/o?uploadType=multipart&ifGenerationMatch=0"
	response, err := storage.request(ctx, http.MethodPost, requestURL, bytes.NewReader(body), contentType)
	clear(body)
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	switch {
	case response.StatusCode >= 200 && response.StatusCode <= 299:
		drainGCSResponse(response.Body)
		return encryptedobject.PutStored, nil
	case response.StatusCode == http.StatusPreconditionFailed:
		drainGCSResponse(response.Body)
		existing, found, getErr := storage.Get(ctx, objectKey)
		if getErr != nil || !found {
			clear(existing)
			return "", ErrGCSOperation
		}
		defer clear(existing)
		if bytes.Equal(existing, value) {
			return encryptedobject.PutAlreadyPresent, nil
		}
		return encryptedobject.PutConflict, nil
	default:
		drainGCSResponse(response.Body)
		return "", ErrGCSOperation
	}
}

func (storage *GCS) Delete(
	ctx context.Context,
	objectKey encryptedobject.ObjectKey,
) (encryptedobject.DeleteResult, error) {
	objectName, err := storage.objectName(ctx, objectKey)
	if err != nil {
		return "", err
	}
	requestURL := storage.endpoint + "/storage/v1/b/" + storage.bucket + "/o/" + url.PathEscape(objectName)
	response, err := storage.request(ctx, http.MethodDelete, requestURL, nil, "")
	if err != nil {
		return "", err
	}
	defer response.Body.Close()
	drainGCSResponse(response.Body)
	if response.StatusCode == http.StatusNotFound {
		return encryptedobject.DeleteNotFound, nil
	}
	if response.StatusCode < 200 || response.StatusCode > 299 {
		return "", ErrGCSOperation
	}
	return encryptedobject.DeleteDeleted, nil
}

func (storage *GCS) List(ctx context.Context) ([]encryptedobject.PrivateObjectDescriptor, error) {
	if storage == nil || ctx == nil {
		return nil, ErrGCSOperation
	}
	result := make([]encryptedobject.PrivateObjectDescriptor, 0)
	pageToken := ""
	seenTokens := map[string]struct{}{"": {}}
	for page := 0; page < gcsMaximumListPages; page++ {
		query := url.Values{
			"prefix":     {gcsObjectPrefix},
			"maxResults": {"1000"},
			"fields":     {"nextPageToken,items(name,metadata)"},
		}
		if pageToken != "" {
			query.Set("pageToken", pageToken)
		}
		requestURL := storage.endpoint + "/storage/v1/b/" + storage.bucket + "/o?" + query.Encode()
		response, err := storage.request(ctx, http.MethodGet, requestURL, nil, "")
		if err != nil {
			return nil, err
		}
		if response.StatusCode != http.StatusOK {
			drainGCSResponse(response.Body)
			_ = response.Body.Close()
			return nil, ErrGCSOperation
		}
		body, err := io.ReadAll(io.LimitReader(response.Body, gcsMaximumResponseBytes+1))
		_ = response.Body.Close()
		if err != nil || len(body) == 0 || len(body) > gcsMaximumResponseBytes {
			return nil, ErrGCSOperation
		}
		var wire struct {
			NextPageToken string `json:"nextPageToken"`
			Items         []struct {
				Name     string            `json:"name"`
				Metadata map[string]string `json:"metadata"`
			} `json:"items"`
		}
		decoder := json.NewDecoder(bytes.NewReader(body))
		if decoder.Decode(&wire) != nil || decoder.Decode(&struct{}{}) != io.EOF ||
			len(wire.NextPageToken) > 4_096 {
			return nil, ErrGCSOperation
		}
		for _, item := range wire.Items {
			if !strings.HasPrefix(item.Name, gcsObjectPrefix) {
				return nil, ErrGCSOperation
			}
			objectKey, err := encryptedobject.ParseObjectKey(strings.TrimPrefix(item.Name, gcsObjectPrefix))
			createdAt, parseErr := strconv.ParseInt(item.Metadata[gcsCreatedAtMetadataKey], 10, 64)
			if err != nil || parseErr != nil || createdAt < 0 || createdAt > 9_007_199_254_740_991 {
				return nil, ErrGCSOperation
			}
			result = append(result, encryptedobject.PrivateObjectDescriptor{
				ObjectKey: objectKey, CreatedAtMilli: createdAt,
			})
		}
		if wire.NextPageToken == "" {
			sort.Slice(result, func(left, right int) bool { return result[left].ObjectKey < result[right].ObjectKey })
			return result, nil
		}
		if _, duplicate := seenTokens[wire.NextPageToken]; duplicate {
			return nil, ErrGCSOperation
		}
		seenTokens[wire.NextPageToken] = struct{}{}
		pageToken = wire.NextPageToken
	}
	return nil, ErrGCSOperation
}

func (storage *GCS) objectName(
	ctx context.Context,
	objectKey encryptedobject.ObjectKey,
) (string, error) {
	if storage == nil || storage.accessToken == nil || storage.client == nil || ctx == nil || ctx.Err() != nil {
		return "", ErrGCSOperation
	}
	if _, err := encryptedobject.ParseObjectKey(string(objectKey)); err != nil {
		return "", ErrGCSOperation
	}
	return gcsObjectPrefix + string(objectKey), nil
}

func (storage *GCS) request(
	ctx context.Context,
	method string,
	requestURL string,
	body io.Reader,
	contentType string,
) (*http.Response, error) {
	if storage == nil || ctx == nil || ctx.Err() != nil {
		return nil, ErrGCSOperation
	}
	token, err := storage.accessToken.ReadAccessToken(ctx)
	if err != nil || len(token) < 20 || len(token) > 8_192 || strings.ContainsAny(token, "\r\n\x00") {
		return nil, ErrGCSOperation
	}
	request, err := http.NewRequestWithContext(ctx, method, requestURL, body)
	if err != nil {
		return nil, ErrGCSOperation
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Authorization", "Bearer "+token)
	if contentType != "" {
		request.Header.Set("Content-Type", contentType)
	}
	response, err := storage.client.Do(request)
	if err != nil || response == nil || response.Body == nil {
		return nil, ErrGCSOperation
	}
	return response, nil
}

func gcsMultipartObject(objectName string, value []byte, createdAtMilli int64) ([]byte, string, error) {
	buffer := &bytes.Buffer{}
	writer := multipart.NewWriter(buffer)
	if err := writer.SetBoundary("fukamu-notes-encrypted-object"); err != nil {
		return nil, "", ErrGCSOperation
	}
	metadataHeader := textproto.MIMEHeader{}
	metadataHeader.Set("Content-Type", "application/json; charset=utf-8")
	metadataPart, err := writer.CreatePart(metadataHeader)
	if err != nil {
		return nil, "", ErrGCSOperation
	}
	metadata := struct {
		Name        string            `json:"name"`
		ContentType string            `json:"contentType"`
		Metadata    map[string]string `json:"metadata"`
	}{
		Name: objectName, ContentType: "application/octet-stream",
		Metadata: map[string]string{gcsCreatedAtMetadataKey: strconv.FormatInt(createdAtMilli, 10)},
	}
	if err := json.NewEncoder(metadataPart).Encode(metadata); err != nil {
		return nil, "", ErrGCSOperation
	}
	mediaHeader := textproto.MIMEHeader{}
	mediaHeader.Set("Content-Type", "application/octet-stream")
	mediaPart, err := writer.CreatePart(mediaHeader)
	if err != nil {
		return nil, "", ErrGCSOperation
	}
	if _, err := mediaPart.Write(value); err != nil || writer.Close() != nil {
		return nil, "", ErrGCSOperation
	}
	return buffer.Bytes(), "multipart/related; boundary=" + writer.Boundary(), nil
}

func validGCSBucket(value string) bool {
	return gcsBucketPattern.MatchString(value) && !strings.Contains(value, "..")
}

func drainGCSResponse(body io.Reader) {
	_, _ = io.Copy(io.Discard, io.LimitReader(body, 64*1024))
}
