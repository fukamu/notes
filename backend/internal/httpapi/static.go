package httpapi

import (
	"errors"
	"fmt"
	"io/fs"
	"mime"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
)

const (
	maximumStaticFileBytes = 8_000_000
	maximumStaticSiteBytes = 64_000_000
	contentSecurityPolicy  = "default-src 'self'; base-uri 'self'; connect-src 'self'; font-src 'self' data:; form-action 'self'; frame-ancestors 'none'; img-src 'self' data: blob:; object-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; worker-src 'self' blob:"
)

var (
	notesCardRoute   = regexp.MustCompile(`^/cards/[^/]+(?:/(?:history|connections))?$`)
	publicRouteFiles = map[string]string{
		"/account/billing":               "account/billing/index.html",
		"/account/privacy":               "account/privacy/index.html",
		"/account/terms":                 "account/terms/index.html",
		"/checkout":                      "checkout/index.html",
		"/company":                       "company/index.html",
		"/legal/commercial-transactions": "legal/commercial-transactions/index.html",
		"/legal/external-transmission":   "legal/external-transmission/index.html",
		"/legal/privacy":                 "legal/privacy/index.html",
		"/legal/terms":                   "legal/terms/index.html",
		"/pricing":                       "pricing/index.html",
	}
	publicStaticFiles = map[string]string{
		"/favicon.svg":          "favicon.svg",
		"/manifest.webmanifest": "manifest.webmanifest",
		"/og.png":               "og.png",
		"/sw.js":                "sw.js",
	}
)

type staticResource struct {
	content     []byte
	contentType string
}

type staticSite struct {
	notesHTML  staticResource
	publicHTML map[string]staticResource
	files      map[string]staticResource
}

func loadStaticSite(directory string) (*staticSite, error) {
	root, err := filepath.Abs(directory)
	if err != nil {
		return nil, errors.New("resolve static directory")
	}
	resources := make(map[string]staticResource)
	totalBytes := int64(0)
	err = filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return errors.New("inspect static site")
		}
		if path == root {
			if !entry.IsDir() {
				return errors.New("static directory must be a directory")
			}
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return errors.New("static site must not contain symbolic links")
		}
		if entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err != nil || !info.Mode().IsRegular() || info.Size() > maximumStaticFileBytes {
			return errors.New("static site contains an invalid file")
		}
		totalBytes += info.Size()
		if totalBytes > maximumStaticSiteBytes {
			return errors.New("static site exceeds the total size limit")
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return errors.New("resolve static file")
		}
		relative = filepath.ToSlash(relative)
		if !fs.ValidPath(relative) {
			return errors.New("static site contains an invalid path")
		}
		content, err := os.ReadFile(path)
		if err != nil {
			return errors.New("read static file")
		}
		contentType := mime.TypeByExtension(filepath.Ext(relative))
		if contentType == "" {
			contentType = "application/octet-stream"
		}
		resources[relative] = staticResource{content: content, contentType: contentType}
		return nil
	})
	if err != nil {
		return nil, fmt.Errorf("load static site: %w", err)
	}

	notesHTML, ok := resources["index.html"]
	if !ok {
		return nil, errors.New("static site is missing index.html")
	}
	publicHTML := make(map[string]staticResource, len(publicRouteFiles))
	for route, filename := range publicRouteFiles {
		resource, ok := resources[filename]
		if !ok {
			return nil, fmt.Errorf("static site is missing %s", filename)
		}
		publicHTML[route] = resource
	}
	files := make(map[string]staticResource)
	for requestPath, filename := range publicStaticFiles {
		resource, ok := resources[filename]
		if !ok {
			return nil, fmt.Errorf("static site is missing %s", filename)
		}
		files[requestPath] = resource
	}
	for filename, resource := range resources {
		if strings.HasPrefix(filename, "assets/") {
			files["/"+filename] = resource
		}
	}
	return &staticSite{notesHTML: notesHTML, publicHTML: publicHTML, files: files}, nil
}

func (site *staticSite) handler() http.HandlerFunc {
	return func(response http.ResponseWriter, request *http.Request) {
		if !allowRead(response, request) {
			return
		}
		if html, ok := site.publicHTML[request.URL.Path]; ok {
			writeStatic(response, request, html, "no-store", true)
			return
		}
		if isNotesRoute(request.URL.Path) {
			writeStatic(response, request, site.notesHTML, "no-store", true)
			return
		}
		if resource, ok := site.files[request.URL.Path]; ok {
			cacheControl := "public, max-age=3600"
			if strings.HasPrefix(request.URL.Path, "/assets/") {
				cacheControl = "public, max-age=31536000, immutable"
			} else if request.URL.Path == "/sw.js" || request.URL.Path == "/manifest.webmanifest" {
				cacheControl = "no-cache"
			}
			writeStatic(response, request, resource, cacheControl, false)
			return
		}
		writeError(response, request, http.StatusNotFound, "not_found")
	}
}

func isNotesRoute(path string) bool {
	return path == "/" || path == "/history" || notesCardRoute.MatchString(path)
}

func writeStatic(
	response http.ResponseWriter,
	request *http.Request,
	resource staticResource,
	cacheControl string,
	html bool,
) {
	response.Header().Set("Cache-Control", cacheControl)
	response.Header().Set("Content-Type", resource.contentType)
	response.Header().Set("Content-Security-Policy", contentSecurityPolicy)
	response.Header().Set("Permissions-Policy", "camera=(), geolocation=(), microphone=()")
	response.Header().Set("Referrer-Policy", "no-referrer")
	response.Header().Set("X-Content-Type-Options", "nosniff")
	if html {
		response.Header().Set("Cross-Origin-Opener-Policy", "same-origin")
		response.Header().Set("X-Frame-Options", "DENY")
	}
	if request.URL.Path == "/sw.js" {
		response.Header().Set("Service-Worker-Allowed", "/")
	}
	response.WriteHeader(http.StatusOK)
	if request.Method != http.MethodHead {
		_, _ = response.Write(resource.content)
	}
}
