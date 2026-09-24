# syntax=docker/dockerfile:1.18@sha256:dabfc0969b935b2080555ace70ee69a5261af8a8f1b4df97b9e7fbcf6722eddf

FROM scratch AS static-assets
COPY backend/static/ /static/

FROM docker.io/library/golang:1.27.1-alpine@sha256:8a5910f31396cd4d89662f56c68b3ae31d374308270a1c3bd96672ee5ed43414 AS go-build
WORKDIR /source/backend
COPY backend/go.mod backend/go.sum ./
RUN go mod download
COPY backend/ ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w -buildid=" -o /out/notes ./cmd/notes

FROM scratch
COPY --from=go-build --chown=65532:65532 /out/notes /notes
COPY --from=static-assets --chown=65532:65532 /static/ /app/static/
USER 65532:65532
EXPOSE 8080
ENV NOTES_ENVIRONMENT=production \
    NOTES_HTTP_ADDR=0.0.0.0:8080 \
    NOTES_STATIC_DIR=/app/static \
    NOTES_BODY_LIMIT_BYTES=4000000 \
    NOTES_SHUTDOWN_TIMEOUT=10s \
    NOTES_LOG_LEVEL=info
ENTRYPOINT ["/notes"]
