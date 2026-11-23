# CLAUDE.md

## Environment Startup Verification

**Default behavior:** starting the environment means starting **only infrastructure services** (database, mail, storage, queue) and the `video-worker`, which starts with Compose — **never** start the NestJS application server unless the user explicitly asks to run/serve the project (e.g., "rode o projeto", "suba o servidor", "run the app").

After starting infrastructure, always confirm the containers are up before proceeding:

```bash
docker compose ps   # all services must show status "running"
```

Then verify each infrastructure service is actually ready to accept connections — not just running:

- **PostgreSQL:** `docker compose exec db pg_isready -U streamtube` — expect `accepting connections`
- **MinIO:** `docker compose exec minio curl -fsS http://localhost:9000/minio/health/live` — expect exit code 0
- **ElasticMQ:** `docker compose exec nestjs-api curl -fsS "http://elasticmq:9324/?Action=ListQueues"` — expect the `video-processing` queues in the response
- **Video worker:** `docker compose exec video-worker pgrep -f dist-worker/worker` — expect a process id

Only start the NestJS dev server (`npm run start:dev`) when the user **explicitly** asks to run the application — never as part of "start the environment".

## Development Environment

This project runs inside Docker. Always use the container for development:

```bash
# Start containers
docker compose up -d

# Install dependencies (first time only)
docker compose exec nestjs-api npm install

# Run the dev server (watch mode)
docker compose exec nestjs-api npm run start:dev
```

Services:
- `nestjs-api` — NestJS API, port `3000`
- `db` — PostgreSQL 17, port `5432`, database `streamtube`, user/password `streamtube`
- `video-worker` — processes videos with FFmpeg, starts with Compose in watch mode, no HTTP port
- `minio` — S3-compatible storage, port `127.0.0.1:9000`, bucket `streamtube`
- `elasticmq` — SQS-compatible queue, reachable only inside the Compose network at `elasticmq:9324`
- `mailpit` — SMTP capture, ports `1025` and `8025`

All verification and teardown commands run on the **host machine**:

```bash
# Verify NestJS is running (expect 200 + "Hello World!")
curl http://localhost:3000

# Verify PostgreSQL is ready (runs inside the db container)
docker compose exec db pg_isready -U streamtube

# Check container logs
docker compose logs nestjs-api
docker compose logs db

# Tear down the entire environment
docker compose down
```

## Commands

**Strict rule:** every `npm`, `npx`, `node`, `tsc`, and test command runs **inside the container**, never on the host. Running on the host causes env-var divergence (`DB_HOST` resolves to `localhost` instead of the Compose service), uses a different Node version, and produces results that do not reflect what runs in CI/prod.

### Container-only commands (always prefix with `docker compose exec nestjs-api`)

```bash
npm run start:dev                        # Dev server with hot-reload
npm run build                            # Compile to dist/
npm run start:prod                       # Run compiled build

npm test                                 # Unit tests
npm run test:watch                       # Unit tests in watch mode
npm run test:cov                         # Coverage report
npm run test:e2e                         # End-to-end tests (always with --runInBand)

npx tsc --noEmit                         # Type-check (required before declaring a task done)
npm run lint                             # ESLint with auto-fix
npm run format                           # Prettier formatting
```

### Host-only commands (Docker / connectivity probes)

```bash
docker compose ps
docker compose logs nestjs-api
docker compose exec db pg_isready -U streamtube
curl http://localhost:3000
```

### Test execution

Integration and e2e suites share a single test database. They **must** be run with `--runInBand`:

```bash
docker compose exec nestjs-api npm test -- --runInBand
docker compose exec nestjs-api npm run test:e2e   # already configured
```

Parallel execution causes FK violations, deadlocks, and cross-suite contamination because suites truncate or seed shared tables concurrently.

During active development, run only the tests related to the file being changed (`npm test -- path/to/file.spec.ts`). Before declaring a task done, run the full suite — see the global `CLAUDE.md` → "Definition of Done (Technical)".

## Long-running Processes

Commands that never exit (dev server, watch modes) must be run in background in the Bash tool — otherwise the agent blocks indefinitely waiting for the process to return.

This applies to: `start:dev`, `start:prod`, `test:watch`, and any other persistent process.

## Test Type Selection

Choose the suffix by what the test really does, not by where the code under test lives. The suffix is a contract that drives Jest config (`testRegex`, parallelism), CI steps, and reader expectations.

| Suffix                  | Purpose                                                              | DB / external I/O | Location                     |
|-------------------------|----------------------------------------------------------------------|-------------------|------------------------------|
| `*.spec.ts`             | **Unit** — pure logic, all collaborators mocked                      | Forbidden         | Next to the source file      |
| `*.integration-spec.ts` | **Integration** — exercises real DB, real repositories, real modules | Required          | Next to the source file      |
| `*.e2e-spec.ts`         | **End-to-end** — full HTTP cycle via `supertest`                     | Required          | `nestjs-project/test/`       |

A test that constructs a `TypeOrmModule.forRoot`, opens a connection, or hits the `db` service **must** be `*.integration-spec.ts`, never `*.spec.ts`. A test that boots the full Nest application and makes HTTP calls **must** be `*.e2e-spec.ts`.

Conventions for **how to write** each kind of test (mocking patterns, AAA structure, override strategies for global guards, etc.) live in `.claude/rules/nestjs-testing.md` and load when you edit a test file.

## Jest Configuration

These settings are required in `package.json` (jest config) and `test/jest-e2e.json` for the project's tests to work correctly:

- `setupFiles: ["dotenv/config"]` — without this, `.env` is not loaded inside the Jest process. `DB_HOST`, `JWT_SECRET`, etc. fall back to undefined or to the host's `localhost`, breaking container-to-container DNS.
- `testRegex: '.*\\.(spec|integration-spec)\\.ts$'` — covers both unit (`*.spec.ts`) and integration (`*.integration-spec.ts`) suffixes.

Do not add new test-file suffixes; if a new test type is needed, update the regex deliberately.

## Environment File Conventions

`.env` is parsed by both Docker Compose and `dotenv` — values containing shell-special characters (`<`, `>`, `|`, `&`, spaces) **must be quoted** or rewritten:

```dotenv
# Wrong — the unquoted angle brackets are shell redirection syntax and break parsing
MAIL_FROM=StreamTube <noreply@streamtube.local>

# Right — quote the value
MAIL_FROM="StreamTube <noreply@streamtube.local>"
```

Whenever possible, prefer storing only the bare address in `.env` and composing display names in code (e.g., in `mail.config.ts`) so the file stays shell-safe.

## Build Assets

`tsc` (and therefore `nest build`) only emits compiled `.ts` files to `dist/`. Any non-TypeScript runtime asset — Handlebars templates (`.hbs`), JSON fixtures, static config files, etc. — must be declared in `nest-cli.json` under `compilerOptions.assets` (with `watchAssets: true` for dev). Without that, the file exists in `src/` but is missing in `dist/` and runtime fails only after build.

## Architecture

NestJS with standard module structure. Source lives in `src/`, compiled output in `dist/`.

- Each domain feature gets its own module (e.g., `UsersModule`, `VideosModule`) registered in `AppModule`
- Controllers handle HTTP routing; Services hold business logic; both are scoped to their module

## Videos

The upload goes directly from the client to the storage through presigned multipart URLs. The API never handles video bytes.

- **Pipeline:** `draft` → `processing` → `ready` or `failed`. `VideoUploadsService` runs the upload, `VideosService` serves metadata, playback and download.
- **Worker (`src/video-worker/`):** `VideoProcessingConsumer` handles one job per replica, `VideoProcessorService` extracts metadata and the thumbnail, `VideoReconcilerService` resends lost jobs, `VideoDlqConsumer` records exhausted jobs and `VideoCleanupService` removes expired drafts and failed videos' objects.
- **Build output:** the API compiles to `dist/` and the worker to `dist-worker/`, because both share the same volume and `deleteOutDir` would erase the other process's output.
- **Accepted formats:** see `src/video-worker/media-allowlist.ts`. There is no transcoding.
- **Storage:** one private bucket, with keys `videos/{videoId}/source` and `videos/{videoId}/thumbnail.jpg`.

All video routes require a Bearer token and act only on the caller's channel. A video from another channel responds `404 VIDEO_NOT_FOUND`. Rate limits apply per user and per route.

| Route | Purpose | Success | Limit per 60s |
|-------|---------|---------|---------------|
| `POST /videos` | Start the multipart upload and create the `draft`, with at most 3 active uploads per channel | 201 | 10 |
| `POST /videos/:id/upload/part-urls` | Sign a batch of up to 50 parts | 201 | 60 |
| `GET /videos/:id/upload/parts` | List uploaded parts to resume an upload | 200 | 30 |
| `POST /videos/:id/upload/complete` | Validate the size, complete the object and enqueue processing | 202 | 10 |
| `GET /videos/:slug` | Return status and metadata through the unique URL | 200 | 120 |
| `GET /videos/:slug/playback` | Return `{ url, expiresAt }` for streaming with Range/206 | 200 | 30 |
| `GET /videos/:slug/download` | Return `{ url, expiresAt }` for an attachment download | 200 | 10 |

Playback and download respond `409 VIDEO_NOT_READY` unless the video is `ready`.

```bash
docker compose logs -f video-worker                  # Follow the worker
docker compose restart video-worker                  # Restart the worker
docker compose exec nestjs-api npm run storage:setup # Create the bucket and CORS rules (idempotent)
docker compose exec nestjs-api npm run build         # Compile the API and worker entry points to dist/
docker compose exec video-worker npm run start:worker # Run the compiled worker from dist/
```

Manual smoke test, with the API server running:

```bash
docker compose exec nestjs-api npx ts-node scripts/smoke-video-upload.ts <file> --expect ready
```

**Test infrastructure:** tests use the real Compose services, with no storage or queue mocks in e2e: database `streamtube_test`, bucket `streamtube-test` and queues `video-processing-test` and `video-processing-test-dlq`. `src/test/test-env.setup.ts` applies these names, and guards refuse to clean anything else. For empty-queue checks, use `queueDepth` or a read with `WaitTimeSeconds: 0`, never the long polling of `receive()`.

## Code Conventions

- **TypeScript:** `nodenext` module resolution, `ES2023` target, `strictNullChecks` on, `noImplicitAny` off
- **Decorators:** `emitDecoratorMetadata` + `experimentalDecorators` enabled — required for NestJS DI
- **Prettier:** single quotes, trailing commas everywhere
- **ESLint:** `no-explicit-any` allowed; `no-floating-promises` and `no-unsafe-argument` are warnings

## REST Conventions

This is a RESTful API. All endpoints must follow standard REST conventions — correct HTTP methods, proper status codes, plural resource nouns, and consistent URL structure. Details are enforced via rules on controller files.
