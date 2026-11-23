---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.14
target_file: nestjs-project/test/videos-access.e2e-spec.ts
---

# Video Access Test Plan

## Application Overview

`GET /videos/:slug`, `GET /videos/:slug/playback` e `GET /videos/:slug/download` expõem o vídeo pela URL única e entregam streaming e download por URLs pré-assinadas. Nesta fase, o acesso é restrito ao dono autenticado, e playback e download exigem status `ready`. A suíte usa PostgreSQL, MinIO, ElasticMQ e FFmpeg reais do Compose, sem mocks de storage ou fila, conforme `phase-03-videos/TD-16`.

## Test Scenarios

### 1. Fluxo completo até reprodução e download

**Setup:** `beforeAll` inicia `AppModule` com `Test.createTestingModule`, aplica o `ValidationPipe` e os filtros de `main.ts`, e obtém `DataSource`, `ThrottlerStorage`, `StorageService` e `VideoProcessingQueueService`. Um segundo módulo de teste compila `VideoWorkerModule` sem chamar `init`, para obter `VideoProcessorService` sem iniciar consumidores nem jobs agendados. Uma fixture MP4 H.264/AAC de 2 segundos, aceita pela allowlist de `phase-03-videos/TD-12`, é gerada por FFmpeg em diretório temporário. `beforeEach` limpa `ThrottlerStorage`, executa `cleanAllTables`, aplica `PurgeQueue` nas filas de teste e cria os usuários A e B confirmados, com login real no padrão de `test/auth.e2e-spec.ts`. `afterEach` remove `source` e `thumbnail.jpg` dos vídeos existentes. `afterAll` remove a fixture e encerra os módulos. O helper `signedRequest` executa GET com `http.request` para `minio:9000`, preservando `Host: localhost:9000` e o caminho e a query da URL assinada.

#### 1.1. complete-video-flow-to-ready

**Covers AC:** #1, #2, #4
**Source:** auto
**Last sync:** 2026-11-23T01:07:05Z

**Steps:**
  1. POST /videos com o nome e o tamanho da fixture, assinar a parte 1 e enviar a fixture ao MinIO real
    - expect: o storage retorna `200` com `ETag`
  2. POST /videos/:id/upload/complete com a parte enviada
    - expect: status `202` e `status: "processing"`
  3. Receber a mensagem real da fila `video-processing-test`, chamar `VideoProcessorService` com o `videoId` e apagar a mensagem
    - expect: a mensagem contém o `id` do vídeo
    - expect: o processamento termina sem erro
  4. GET /videos/:slug com o token do dono
    - expect: status `200` e `status: "ready"`
    - expect: `durationSeconds` é aproximadamente `2`, `width` e `height` correspondem à fixture, e `videoCodec`, `audioCodec`, `container` e `contentType` estão preenchidos
    - expect: `thumbnailUrl` é uma URL assinada
  5. Executar GET em `thumbnailUrl` com `signedRequest`
    - expect: status `200` com bytes de um JPEG válido
  6. GET /videos/:slug/playback e executar GET na URL com `Range: bytes=0-1023`
    - expect: a API retorna `200` com `url` e `expiresAt`
    - expect: o storage retorna `206`, `Content-Range` iniciado em `bytes 0-1023/`, `Content-Length: 1024`, `Content-Type` igual ao `contentType` e `Content-Disposition` iniciado em `inline`
  7. GET /videos/:slug/download e executar GET na URL
    - expect: a API retorna `200` com `url` e `expiresAt`
    - expect: o storage retorna `200` com `Content-Disposition` iniciado em `attachment`
    - expect: o SHA-256 do corpo é igual ao da fixture

### 2. GET /videos/:slug — consulta

**Setup:** Mesmo setup do grupo 1. Os vídeos são inseridos diretamente no banco com slug válido.

#### 2.1. get-video-before-ready

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-23T01:07:05Z

**Steps:**
  1. Inserir vídeos do usuário A em `draft`, `processing` e `failed`, este com `failure_code: "UNSUPPORTED_FORMAT"`
    - expect: os três vídeos existem
  2. GET /videos/:slug de cada vídeo com o token do dono
    - expect: status `200` com o `status` correspondente
    - expect: `thumbnailUrl` é `null` nos três casos
    - expect: `failureCode` é `UNSUPPORTED_FORMAT` no vídeo em `failed` e `null` nos demais

### 3. GET /videos/:slug/playback — validade

**Setup:** Mesmo setup do grupo 1. Os vídeos são inseridos em `ready`, com `content_type` e `duration_seconds` definidos.

#### 3.1. cap-playback-url-at-7-days

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-23T01:07:05Z

**Steps:**
  1. Inserir um vídeo `ready` com `duration_seconds: 302401`, acima de 84 horas
    - expect: o vídeo existe
  2. GET /videos/:slug/playback com o token do dono
    - expect: status `200`
    - expect: a URL contém `X-Amz-Expires=604800`
    - expect: `expiresAt` fica a 7 dias da chamada, com tolerância de 1 minuto

#### 3.2. calculate-playback-url-validity

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-23T01:07:05Z

**Steps:**
  1. Inserir um vídeo `ready` com `duration_seconds: 60` e chamar GET /videos/:slug/playback
    - expect: a URL contém `X-Amz-Expires=3600`
  2. Inserir um vídeo `ready` com `duration_seconds: 7200` e chamar GET /videos/:slug/playback
    - expect: a URL contém `X-Amz-Expires=14400`

### 4. GET /videos/:slug/download — nome e validade

**Setup:** Mesmo setup do grupo 1. O objeto `videos/{id}/source` é gravado com um arquivo pequeno por `StorageService.putObject`.

#### 4.1. sanitize-download-filename

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-23T01:07:05Z

**Steps:**
  1. Inserir um vídeo `ready` com `original_filename` contendo aspas, barras, `\r\n` e acentos, e gravar seu objeto
    - expect: o objeto existe
  2. GET /videos/:slug/download com o token do dono
    - expect: status `200`
    - expect: a URL contém `X-Amz-Expires=21600`
  3. Executar GET na URL com `signedRequest`
    - expect: `Content-Disposition` inicia em `attachment`
    - expect: o nome no header não contém quebra de linha, aspas sem escape nem separadores de caminho

### 5. Vídeos — autorização e erros

**Setup:** Mesmo setup do grupo 1. Os vídeos são inseridos diretamente no banco.

#### 5.1. reject-playback-and-download-when-not-ready

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-23T01:07:05Z

**Steps:**
  1. Inserir vídeos do usuário A em `draft`, `processing` e `failed`
    - expect: os três vídeos existem
  2. GET /videos/:slug/playback e GET /videos/:slug/download em cada vídeo, com o token do dono
    - expect: status `409` em todas as chamadas
    - expect: body com `error: "VIDEO_NOT_READY"`, sem `url`

#### 5.2. hide-video-from-other-channel

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-11-23T01:07:05Z

**Steps:**
  1. Inserir um vídeo `ready` do usuário A
    - expect: o vídeo existe
  2. Chamar as três rotas com o token do usuário B
    - expect: status `404` nas três
    - expect: body com `error: "VIDEO_NOT_FOUND"`, sem metadados nem `url`

#### 5.3. return-not-found-for-unknown-or-invalid-slug

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-11-23T01:07:05Z

**Steps:**
  1. Chamar as três rotas com um slug base62 válido e inexistente
    - expect: status `404` e `error: "VIDEO_NOT_FOUND"`
  2. Chamar as três rotas com slugs malformados: curto, longo e com caractere fora de base62
    - expect: status `404` e `error: "VIDEO_NOT_FOUND"`

#### 5.4. reject-access-without-token

**Covers AC:** #7
**Source:** auto
**Last sync:** 2026-11-23T01:07:05Z

**Steps:**
  1. Inserir um vídeo `ready` do usuário A
    - expect: o vídeo existe
  2. Chamar as três rotas sem `Authorization`
    - expect: status `401` nas três
  3. Chamar as três rotas com token malformado
    - expect: status `401` nas três
