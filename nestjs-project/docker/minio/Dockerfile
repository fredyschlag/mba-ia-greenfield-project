# Local-only MinIO image, built from the pinned official release tag.
# Production uses Amazon S3.
FROM golang:1.24.8-alpine AS builder

ARG MINIO_RELEASE=RELEASE.2025-10-15T17-29-55Z
ARG MINIO_VERSION=2025-10-15T17:29:55Z

RUN apk add --no-cache git
RUN git clone --depth 1 --branch "${MINIO_RELEASE}" https://github.com/minio/minio.git /src \
  && cd /src \
  && COMMIT_ID="$(git rev-parse HEAD)" \
  && CGO_ENABLED=0 go build -tags kqueue -trimpath \
    -ldflags "-s -w \
      -X github.com/minio/minio/cmd.Version=${MINIO_VERSION} \
      -X github.com/minio/minio/cmd.ReleaseTag=${MINIO_RELEASE} \
      -X github.com/minio/minio/cmd.CommitID=${COMMIT_ID}" \
    -o /usr/local/bin/minio . \
  && go clean -cache -modcache \
  && rm -rf /src

FROM alpine:3.22

RUN apk add --no-cache ca-certificates curl \
  && addgroup -S minio \
  && adduser -S -G minio minio \
  && mkdir -p /data \
  && chown minio:minio /data

COPY --from=builder /usr/local/bin/minio /usr/local/bin/minio

USER minio

EXPOSE 9000

ENTRYPOINT ["minio"]
CMD ["server", "/data", "--address", ":9000", "--console-address", ":9001"]
