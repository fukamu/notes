package objectstorage

import (
	"context"
	"encoding/json"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"

	"github.com/fukamu/notes/backend/internal/encryptedobject"
)

type gcsTokenStub struct{}

func (gcsTokenStub) ReadAccessToken(context.Context) (string, error) {
	return "short-lived-production-token", nil
}

type gcsObjectFixture struct {
	value     []byte
	createdAt int64
}

func TestGCSPrivateObjectLifecycleAndIdempotency(t *testing.T) {
	t.Parallel()
	key, _ := encryptedobject.ParseObjectKey("obj_v1_" + strings.Repeat("A", 43))
	objects := make(map[string]gcsObjectFixture)
	var mutex sync.Mutex
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "Bearer short-lived-production-token" {
			response.WriteHeader(http.StatusUnauthorized)
			return
		}
		mutex.Lock()
		defer mutex.Unlock()
		switch {
		case request.Method == http.MethodPost && request.URL.Path == "/upload/storage/v1/b/notes-private-1/o":
			if request.URL.Query().Get("uploadType") != "multipart" ||
				request.URL.Query().Get("ifGenerationMatch") != "0" {
				response.WriteHeader(http.StatusBadRequest)
				return
			}
			name, value, createdAt := readGCSMultipartFixture(t, request)
			if _, exists := objects[name]; exists {
				response.WriteHeader(http.StatusPreconditionFailed)
				return
			}
			objects[name] = gcsObjectFixture{value: value, createdAt: createdAt}
			response.Header().Set("Content-Type", "application/json")
			_, _ = response.Write([]byte(`{"generation":"1"}`))
		case request.Method == http.MethodGet && request.URL.Path == "/storage/v1/b/notes-private-1/o":
			items := make([]map[string]any, 0, len(objects))
			for name, object := range objects {
				items = append(items, map[string]any{
					"name": name,
					"metadata": map[string]string{
						gcsCreatedAtMetadataKey: strconv.FormatInt(object.createdAt, 10),
					},
				})
			}
			_ = json.NewEncoder(response).Encode(map[string]any{"items": items})
		case strings.Contains(request.URL.EscapedPath(), "/o/objects%2F"):
			name := strings.TrimPrefix(request.URL.Path, "/storage/v1/b/notes-private-1/o/")
			object, found := objects[name]
			if request.Method == http.MethodDelete {
				if !found {
					response.WriteHeader(http.StatusNotFound)
					return
				}
				delete(objects, name)
				response.WriteHeader(http.StatusNoContent)
				return
			}
			if request.Method != http.MethodGet || !found {
				response.WriteHeader(http.StatusNotFound)
				return
			}
			_, _ = response.Write(object.value)
		default:
			response.WriteHeader(http.StatusBadRequest)
		}
	}))
	defer server.Close()

	storage, err := newGCS("notes-private-1", gcsTokenStub{}, server.Client(), server.URL)
	if err != nil {
		t.Fatal(err)
	}
	plaintext := []byte("opaque-envelope-ciphertext")
	if result, err := storage.PutIfAbsent(context.Background(), key, plaintext, 1_500); err != nil ||
		result != encryptedobject.PutStored {
		t.Fatalf("PutIfAbsent() = %q, %v", result, err)
	}
	if result, err := storage.PutIfAbsent(context.Background(), key, plaintext, 1_500); err != nil ||
		result != encryptedobject.PutAlreadyPresent {
		t.Fatalf("replayed PutIfAbsent() = %q, %v", result, err)
	}
	if result, err := storage.PutIfAbsent(context.Background(), key, []byte("different"), 1_500); err != nil ||
		result != encryptedobject.PutConflict {
		t.Fatalf("conflicting PutIfAbsent() = %q, %v", result, err)
	}
	value, found, err := storage.Get(context.Background(), key)
	if err != nil || !found || string(value) != string(plaintext) {
		t.Fatalf("Get() = %q, %t, %v", value, found, err)
	}
	listed, err := storage.List(context.Background())
	if err != nil || len(listed) != 1 || listed[0].ObjectKey != key || listed[0].CreatedAtMilli != 1_500 {
		t.Fatalf("List() = %#v, %v", listed, err)
	}
	if result, err := storage.Delete(context.Background(), key); err != nil || result != encryptedobject.DeleteDeleted {
		t.Fatalf("Delete() = %q, %v", result, err)
	}
	if result, err := storage.Delete(context.Background(), key); err != nil || result != encryptedobject.DeleteNotFound {
		t.Fatalf("replayed Delete() = %q, %v", result, err)
	}
}

func TestGCSFailsClosedForInvalidConfigurationAndProviderResponses(t *testing.T) {
	t.Parallel()
	if _, err := NewGCS("INVALID", gcsTokenStub{}, http.DefaultClient); err != ErrGCSConfiguration {
		t.Fatalf("NewGCS() error = %v", err)
	}
	key, _ := encryptedobject.ParseObjectKey("obj_v1_" + strings.Repeat("B", 43))
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method == http.MethodGet && request.URL.Path == "/storage/v1/b/notes-private-1/o" {
			_, _ = response.Write([]byte(`{"items":[{"name":"objects/not-a-key","metadata":{"fukamuCreatedAtMillis":"1"}}]}`))
			return
		}
		response.WriteHeader(http.StatusServiceUnavailable)
		_, _ = response.Write([]byte("private provider failure"))
	}))
	defer server.Close()
	storage, _ := newGCS("notes-private-1", gcsTokenStub{}, server.Client(), server.URL)
	if _, _, err := storage.Get(context.Background(), key); err != ErrGCSOperation {
		t.Fatalf("Get() error = %v", err)
	}
	if _, err := storage.List(context.Background()); err != ErrGCSOperation {
		t.Fatalf("List() error = %v", err)
	}
}

func readGCSMultipartFixture(t *testing.T, request *http.Request) (string, []byte, int64) {
	t.Helper()
	mediaType, parameters, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
	if err != nil || mediaType != "multipart/related" {
		t.Fatalf("Content-Type = %q, %v", request.Header.Get("Content-Type"), err)
	}
	reader := multipart.NewReader(request.Body, parameters["boundary"])
	metadataPart, err := reader.NextPart()
	if err != nil {
		t.Fatal(err)
	}
	var metadata struct {
		Name     string            `json:"name"`
		Metadata map[string]string `json:"metadata"`
	}
	if err := json.NewDecoder(metadataPart).Decode(&metadata); err != nil {
		t.Fatal(err)
	}
	mediaPart, err := reader.NextPart()
	if err != nil {
		t.Fatal(err)
	}
	value, err := io.ReadAll(mediaPart)
	if err != nil {
		t.Fatal(err)
	}
	createdAt, err := strconv.ParseInt(metadata.Metadata[gcsCreatedAtMetadataKey], 10, 64)
	if err != nil {
		t.Fatal(err)
	}
	return metadata.Name, value, createdAt
}
