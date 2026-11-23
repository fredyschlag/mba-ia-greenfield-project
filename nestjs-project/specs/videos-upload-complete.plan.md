---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.9
target_file: nestjs-project/test/videos-upload-complete.e2e-spec.ts
---

# POST /videos/:id/upload/complete Test Plan

## Application Overview

`POST /videos/:id/upload/complete` valida as partes reais, conclui o objeto, confere o tamanho final e inicia o processamento publicando `{ videoId }` na fila. A chamada é idempotente: uma nova tentativa após uma resposta perdida não cria uma segunda mensagem. A suíte usa MinIO, PostgreSQL e ElasticMQ reais do Compose, sem mocks de storage ou fila, conforme `phase-03-videos/TD-16`. Cenários de contrato sem critério próprio seguem `### API Contracts` e referenciam o critério principal da rota.

## Test Scenarios

### 1. POST /videos/:id/upload/complete — conclusão

**Setup:** `beforeAll` inicia `AppModule` com `Test.createTestingModule`, aplica o `ValidationPipe` e os filtros de `main.ts`, e obtém `DataSource`, `ThrottlerStorage`, `StorageService` e `VideoProcessingQueueService`. `beforeEach` limpa `ThrottlerStorage`, executa `cleanAllTables`, aplica `PurgeQueue` nas filas de teste e cria os usuários A e B confirmados, com login real no padrão de `test/auth.e2e-spec.ts`. `afterEach` aborta os multiparts dos vídeos existentes e remove os objetos restantes. O helper `uploadPart` assina a parte pela API e envia os bytes com `http.request` para `minio:9000`, preservando `Host: localhost:9000`. Os arquivos de uma parte têm 1024 bytes, e nenhum teste envia um arquivo grande.

#### 1.1. complete-upload-and-enqueue

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-23T01:07:05Z

**Steps:**
  1. Criar um rascunho do usuário A com `sizeBytes: 1024` e enviar a parte 1
    - expect: o storage retorna `ETag`
  2. POST /videos/:id/upload/complete com `{ "parts": [{ "partNumber": 1, "etag": "<etag>" }] }`
    - expect: status `202`
    - expect: body contém `id`, `slug` e `status: "processing"`
  3. Consultar o vídeo e o objeto
    - expect: `status` é `processing`, `size_bytes` é `1024`, `upload_id` é nulo e `job_enqueued_at` está preenchido
    - expect: `HeadObject` em `videos/{id}/source` retorna `ContentLength: 1024`
  4. Ler a fila real `video-processing-test`
    - expect: existe exatamente 1 mensagem, com payload `{ "videoId": "<id>" }`

#### 1.2. repeat-complete-without-new-message

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-23T01:07:05Z

**Steps:**
  1. Concluir um upload de 1024 bytes com sucesso
    - expect: status `202` e `status: "processing"`
  2. Repetir a mesma chamada
    - expect: status `202` e `status: "processing"`
  3. Ler a fila real de teste
    - expect: existe exatamente 1 mensagem para o vídeo

#### 1.3. recover-lost-complete-response

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-23T01:07:05Z

**Steps:**
  1. Criar um rascunho, enviar a parte 1 e chamar `StorageService.completeMultipartUpload` diretamente, simulando uma queda antes de atualizar o banco
    - expect: o objeto existe com 1024 bytes
    - expect: o vídeo continua em `draft`
  2. POST /videos/:id/upload/complete com a parte enviada
    - expect: status `202` e `status: "processing"`
  3. Consultar o vídeo e ler a fila real
    - expect: `size_bytes` é `1024`
    - expect: existe exatamente 1 mensagem para o vídeo

#### 1.4. return-accepted-for-ready-video

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-23T01:07:05Z

**Steps:**
  1. Concluir um upload, esvaziar a fila de teste e atualizar o vídeo para `ready`
    - expect: a fila não tem mensagens
  2. Repetir POST /videos/:id/upload/complete
    - expect: status `202` e `status: "ready"`
  3. Ler a fila real
    - expect: nenhuma mensagem é publicada

### 2. POST /videos/:id/upload/complete — divergências

**Setup:** Mesmo setup do grupo 1.

#### 2.1. reject-missing-parts

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-23T01:07:05Z

**Steps:**
  1. Criar um rascunho com `sizeBytes: 20000000`, com 2 partes, e enviar somente a parte 1, de 16777216 bytes
    - expect: o storage retorna `ETag`
  2. POST /videos/:id/upload/complete com a parte 1
    - expect: status `409`
    - expect: body com `error: "UPLOAD_INCOMPLETE"`
  3. Consultar o vídeo, o storage e a fila
    - expect: o vídeo continua em `draft`, com `upload_id` preenchido
    - expect: `ListParts` ainda retorna a parte 1
    - expect: a fila não tem mensagens

#### 2.2. reject-mismatched-etag

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-23T01:07:05Z

**Steps:**
  1. Criar um rascunho de 1024 bytes e enviar a parte 1
    - expect: o storage retorna `ETag`
  2. POST /videos/:id/upload/complete com um `etag` diferente
    - expect: status `409`
    - expect: body com `error: "UPLOAD_INCOMPLETE"`
    - expect: o vídeo continua em `draft`
  3. Repetir a chamada com o `etag` correto
    - expect: status `202`, confirmando que o rascunho continuou retomável

#### 2.3. fail-on-final-size-mismatch

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-23T01:07:05Z

**Steps:**
  1. Criar um rascunho de 1024 bytes, enviar a parte 1, concluir o multipart diretamente e sobrescrever `videos/{id}/source` com um objeto real de 512 bytes
    - expect: `HeadObject` retorna `ContentLength: 512`
  2. POST /videos/:id/upload/complete com a parte enviada
    - expect: status `422`
    - expect: body com `error: "VIDEO_SIZE_MISMATCH"`
  3. Consultar o vídeo, o storage e a fila
    - expect: `status` é `failed`, `failure_code` é `SIZE_MISMATCH` e `storage_purged_at` está preenchido
    - expect: `HeadObject` indica que o objeto não existe
    - expect: a fila não tem mensagens

### 3. POST /videos/:id/upload/complete — contrato da requisição

**Setup:** Mesmo setup do grupo 1.

#### 3.1. reject-invalid-complete-request

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-23T01:07:05Z

**Steps:**
  1. Criar um rascunho do usuário A
    - expect: status `201`
  2. POST /videos/:id/upload/complete com cada body inválido: sem `parts`, array vazio, 641 itens, `partNumber` repetido, `partNumber: 0`, `etag` vazio e campo extra
    - expect: status `400` em todos os casos
    - expect: o vídeo continua em `draft`
  3. Chamar a rota com `:id` que não é UUID
    - expect: status `400`

#### 3.2. reject-complete-without-token

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-23T01:07:05Z

**Steps:**
  1. Criar um rascunho e enviar a parte 1
    - expect: o storage retorna `ETag`
  2. Chamar a rota sem `Authorization` e depois com token malformado
    - expect: status `401` nas duas chamadas
    - expect: o vídeo continua em `draft`
    - expect: a fila não tem mensagens

### 4. POST /videos/:id/upload/complete — erros de domínio

**Setup:** Mesmo setup do grupo 1.

#### 4.1. hide-video-from-other-channel

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-23T01:07:05Z

**Steps:**
  1. Criar um rascunho do usuário A e enviar a parte 1
    - expect: o storage retorna `ETag`
  2. Chamar a rota com o token do usuário B
    - expect: status `404`
    - expect: body com `error: "VIDEO_NOT_FOUND"`
    - expect: o vídeo continua em `draft`, e a fila não tem mensagens
  3. Chamar a rota com um UUID inexistente e o token do usuário A
    - expect: status `404` com o mesmo `error`

#### 4.2. reject-expired-upload

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-11-23T01:07:05Z

**Steps:**
  1. Criar um rascunho, enviar a parte 1 e atualizar `upload_expires_at` para 1 minuto no passado
    - expect: o vídeo continua em `draft`
  2. POST /videos/:id/upload/complete com a parte enviada
    - expect: status `410`
    - expect: body com `error: "UPLOAD_EXPIRED"`
    - expect: o vídeo continua em `draft`, e a fila não tem mensagens

#### 4.3. reject-failed-video

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-23T01:07:05Z

**Steps:**
  1. Criar um rascunho, abortar o multipart real e atualizar o vídeo para `failed`
    - expect: o vídeo está em `failed`
  2. POST /videos/:id/upload/complete com uma parte válida no formato
    - expect: status `409`
    - expect: body com `error: "UPLOAD_NOT_ACTIVE"`
    - expect: a fila não tem mensagens
