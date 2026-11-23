---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.8
target_file: nestjs-project/test/videos-upload-parts.e2e-spec.ts
---

# Upload Parts Test Plan

## Application Overview

`POST /videos/:id/upload/part-urls` assina lotes de até 50 partes para envio direto ao storage, e `GET /videos/:id/upload/parts` lista as partes já recebidas para retomar um upload interrompido. As rotas são restritas ao dono do canal e a rascunhos com sessão válida. A suíte usa MinIO, PostgreSQL e ElasticMQ reais do Compose, sem mocks de storage ou fila, conforme `phase-03-videos/TD-16`. Cenários de contrato sem critério próprio seguem `### API Contracts` e referenciam o critério principal da rota.

## Test Scenarios

### 1. POST /videos/:id/upload/part-urls — assinatura de partes

**Setup:** `beforeAll` inicia `AppModule` com `Test.createTestingModule`, aplica o `ValidationPipe` e os filtros de `main.ts`, e obtém `DataSource`, `ThrottlerStorage` e `StorageService`. `beforeEach` limpa `ThrottlerStorage`, executa `cleanAllTables` e cria os usuários A e B confirmados, com login real no padrão de `test/auth.e2e-spec.ts`. `afterEach` aborta os multiparts dos vídeos existentes e remove os objetos restantes. O helper `signedRequest` envia PUT e GET com `http.request` para `minio:9000`, preservando `Host: localhost:9000` e o caminho e a query da URL assinada.

#### 1.1. sign-upload-part-urls

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-23T01:07:05Z

**Steps:**
  1. Criar um rascunho do usuário A com `sizeBytes: 40000000`
    - expect: `partCount` é `3`
  2. POST /videos/:id/upload/part-urls com `{ "partNumbers": [1, 2, 3] }`
    - expect: status `201`
    - expect: `parts` tem 3 itens com `partNumber`, `url` e `contentLength`
    - expect: `expiresAt` fica a 1 hora da assinatura, com tolerância de 1 minuto
    - expect: cada `url` usa o host `localhost:9000`, assina `content-length` e não contém parâmetros `x-amz-checksum` nem `x-amz-sdk-checksum-algorithm`

#### 1.2. sign-maximum-batch-of-50-parts

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-23T01:07:05Z

**Steps:**
  1. Criar um rascunho com `sizeBytes: 838860800`
    - expect: `partCount` é `50`
  2. POST /videos/:id/upload/part-urls com os números de 1 a 50
    - expect: status `201`
    - expect: `parts` tem 50 itens, na ordem pedida
    - expect: todos os `contentLength` são `16777216`

#### 1.3. calculate-last-part-content-length

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-23T01:07:05Z

**Steps:**
  1. Criar um rascunho com `sizeBytes: 40000000` e assinar as partes 2 e 3
    - expect: a parte 2 tem `contentLength: 16777216`
    - expect: a parte 3 tem `contentLength: 6445568`
  2. Criar um rascunho com `sizeBytes: 1024` e assinar a parte 1
    - expect: `contentLength` é `1024`
  3. Enviar 1023 bytes à URL assinada com `signedRequest`
    - expect: o storage rejeita a requisição com status `403`
  4. Enviar exatamente 1024 bytes à mesma URL
    - expect: o storage retorna `200` com header `ETag`

### 2. GET /videos/:id/upload/parts — retomada

**Setup:** Mesmo setup do grupo 1.

#### 2.1. list-uploaded-parts

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-23T01:07:05Z

**Steps:**
  1. Criar um rascunho do usuário A com `sizeBytes: 1024`
    - expect: status `201`
  2. GET /videos/:id/upload/parts antes de enviar bytes
    - expect: status `200`
    - expect: `partSizeBytes`, `partCount` e `uploadExpiresAt` correspondem ao rascunho
    - expect: `parts` é um array vazio
  3. Assinar a parte 1 e enviar 1024 bytes com `signedRequest`
    - expect: o storage retorna `200` com `ETag`
  4. GET /videos/:id/upload/parts novamente
    - expect: status `200`
    - expect: `parts` contém `{ partNumber: 1, sizeBytes: 1024, etag }`, com o mesmo `ETag` retornado pelo storage

### 3. Upload parts — contrato da requisição

**Setup:** Mesmo setup do grupo 1.

#### 3.1. reject-invalid-sign-request

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-23T01:07:05Z

**Steps:**
  1. Criar um rascunho com `sizeBytes: 838860800`
    - expect: status `201`
  2. POST /videos/:id/upload/part-urls com 51 números de parte
    - expect: status `400`
  3. Repetir com cada body inválido: sem `partNumbers`, array vazio, números repetidos, `0`, número negativo, decimal, string e campo extra
    - expect: status `400` em todos os casos
  4. Chamar as duas rotas com `:id` que não é UUID
    - expect: status `400`

#### 3.2. reject-part-number-above-part-count

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-23T01:07:05Z

**Steps:**
  1. Criar um rascunho com `partCount: 3`
    - expect: status `201`
  2. POST /videos/:id/upload/part-urls com `{ "partNumbers": [1, 4] }`
    - expect: status `400`
    - expect: body com `error: "INVALID_PART_NUMBER"`
    - expect: a resposta não contém URLs assinadas

#### 3.3. reject-upload-routes-without-token

**Covers AC:** #1, #5
**Source:** auto
**Last sync:** 2026-11-23T01:07:05Z

**Steps:**
  1. Criar um rascunho do usuário A
    - expect: status `201`
  2. Chamar as duas rotas sem `Authorization`
    - expect: status `401` nas duas
  3. Chamar as duas rotas com token malformado
    - expect: status `401` nas duas

### 4. Upload parts — erros de domínio

**Setup:** Mesmo setup do grupo 1.

#### 4.1. hide-video-from-other-channel

**Covers AC:** #6
**Source:** auto
**Last sync:** 2026-11-23T01:07:05Z

**Steps:**
  1. Criar um rascunho do usuário A
    - expect: status `201`
  2. Chamar as duas rotas com o token do usuário B
    - expect: status `404` nas duas
    - expect: body com `error: "VIDEO_NOT_FOUND"`, sem URLs nem dados do vídeo
  3. Chamar as duas rotas com um UUID inexistente e o token do usuário A
    - expect: status `404` com o mesmo `error`

#### 4.2. reject-expired-upload-session

**Covers AC:** #7
**Source:** auto
**Last sync:** 2026-11-23T01:07:05Z

**Steps:**
  1. Criar um rascunho e atualizar `upload_expires_at` para 1 minuto no passado
    - expect: o vídeo continua em `draft`
  2. Chamar as duas rotas com o token do dono
    - expect: status `410` nas duas
    - expect: body com `error: "UPLOAD_EXPIRED"`

#### 4.3. reject-upload-not-active

**Covers AC:** #1, #5
**Source:** auto
**Last sync:** 2026-11-23T01:07:05Z

**Steps:**
  1. Criar um rascunho e abortar o multipart real, para o vídeo não deixar upload aberto
    - expect: o multipart deixa de existir
  2. Atualizar o vídeo para cada status `processing`, `ready` e `failed`, e chamar as duas rotas com o token do dono
    - expect: status `409` em todos os casos
    - expect: body com `error: "UPLOAD_NOT_ACTIVE"`
