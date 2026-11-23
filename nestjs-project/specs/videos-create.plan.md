---
subproject: backend
runner: jest+supertest
scope: phase-03-videos
si: SI-03.7
target_file: nestjs-project/test/videos-create.e2e-spec.ts
---

# POST /videos Test Plan

## Application Overview

`POST /videos` inicia o multipart no storage e cria o vídeo como rascunho em uma única chamada. A rota exige usuário autenticado, limita o arquivo a 10 GiB e permite no máximo 3 uploads ativos por canal. A suíte usa a infraestrutura real do Compose (`streamtube_test`, `streamtube-test` e filas de teste do ElasticMQ), sem mocks de storage ou fila, conforme `phase-03-videos/TD-16`. Nenhum teste envia os bytes de um arquivo de 10 GiB: os limites usam apenas `sizeBytes`, e todo multipart criado é abortado. Cenários de contrato sem critério próprio, como validação e `401`, seguem `### API Contracts` e referenciam o critério principal da rota.

## Test Scenarios

### 1. POST /videos — criação do rascunho

**Setup:** `beforeAll` inicia `AppModule` com `Test.createTestingModule`, aplica o `ValidationPipe` e os filtros de `main.ts`, e obtém `DataSource`, `ThrottlerStorage` e `StorageService`. `beforeEach` limpa `ThrottlerStorage`, executa `cleanAllTables` e cria um usuário confirmado com login real, no padrão de `test/auth.e2e-spec.ts`. `afterEach` lê os vídeos com `upload_id`, aborta os multiparts em `videos/{id}/source` e remove os objetos restantes. `afterAll` encerra a aplicação.

#### 1.1. create-draft-video

**Covers AC:** #1, #7
**Source:** auto
**Last sync:** 2026-11-23T01:07:05Z

**Steps:**
  1. POST /videos com token válido e body `{ "filename": "aula final.mp4", "sizeBytes": 40000000 }`
    - expect: status `201`
    - expect: body contém `id` (uuid), `slug` com 11 caracteres base62, `status: "draft"`, `partSizeBytes: 16777216`, `partCount: 3` e `uploadExpiresAt` em ISO-8601
    - expect: `uploadExpiresAt` fica a 48 horas da criação, com tolerância de 1 minuto
  2. Consultar o vídeo no banco com `upload_id` selecionado explicitamente
    - expect: `channel_id` é o canal do usuário, `status` é `draft`, `original_filename` é `aula final.mp4`, `declared_size_bytes` é `40000000` e `upload_id` está preenchido
  3. Executar `ListParts` real em `videos/{id}/source` com o `upload_id`
    - expect: o multipart existe nessa chave, com zero partes
    - expect: a chave não contém `aula final.mp4`

#### 1.2. accept-maximum-size-with-640-parts

**Covers AC:** #2
**Source:** auto
**Last sync:** 2026-11-23T01:07:05Z

**Steps:**
  1. POST /videos com `{ "filename": "limite.mp4", "sizeBytes": 10737418240 }`, sem enviar bytes ao storage
    - expect: status `201`
    - expect: `partSizeBytes` é `16777216` e `partCount` é `640`
  2. Consultar o vídeo no banco
    - expect: `declared_size_bytes` é `10737418240`, sem perda de precisão

### 2. POST /videos — contrato da requisição

**Setup:** Mesmo setup do grupo 1, com um spy sem `mockImplementation` em `StorageService.createMultipartUpload`, mantendo a chamada real.

#### 2.1. reject-invalid-request-body

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-23T01:07:05Z

**Steps:**
  1. POST /videos com cada body inválido: sem `filename`, `filename` vazio, `filename` com 256 caracteres, sem `sizeBytes`, `sizeBytes: 0`, `sizeBytes: -1`, `sizeBytes: 1.5`, `sizeBytes: "100"` e campo extra `status`
    - expect: status `400` em todos os casos
    - expect: nenhum registro é criado em `videos`
    - expect: `createMultipartUpload` não é chamado

#### 2.2. reject-request-without-token

**Covers AC:** #1
**Source:** auto
**Last sync:** 2026-11-23T01:07:05Z

**Steps:**
  1. POST /videos com body válido, sem o header `Authorization`
    - expect: status `401`
  2. POST /videos com body válido e token malformado
    - expect: status `401`
    - expect: nenhum registro é criado em `videos`
    - expect: `createMultipartUpload` não é chamado

### 3. POST /videos — erros de domínio e limites

**Setup:** Mesmo setup do grupo 1, com spies sem `mockImplementation` em `StorageService.createMultipartUpload` e `StorageService.abortMultipartUpload`, mantendo as chamadas reais.

#### 3.1. reject-size-above-limit

**Covers AC:** #3
**Source:** auto
**Last sync:** 2026-11-23T01:07:05Z

**Steps:**
  1. POST /videos com `{ "filename": "grande.mp4", "sizeBytes": 10737418241 }`
    - expect: status `413`
    - expect: body com `statusCode: 413` e `error: "VIDEO_TOO_LARGE"`
    - expect: nenhum registro é criado em `videos`
    - expect: `createMultipartUpload` não é chamado

#### 3.2. reject-fourth-active-upload

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-23T01:07:05Z

**Steps:**
  1. Criar 3 rascunhos em sequência com POST /videos
    - expect: status `201` nas 3 chamadas
  2. POST /videos com um quarto arquivo válido
    - expect: status `409`
    - expect: body com `error: "ACTIVE_UPLOAD_LIMIT_REACHED"`
    - expect: `videos` continua com 3 registros
    - expect: a diferença entre chamadas de `createMultipartUpload` e `abortMultipartUpload` é 3, sem multipart extra aberto

#### 3.3. limit-concurrent-uploads-per-channel

**Covers AC:** #5
**Source:** auto
**Last sync:** 2026-11-23T01:07:05Z

**Steps:**
  1. Disparar 4 POST /videos simultâneos com o mesmo token
    - expect: exatamente 3 respostas `201` e 1 resposta `409 ACTIVE_UPLOAD_LIMIT_REACHED`
    - expect: `videos` contém 3 registros do canal
    - expect: a diferença entre chamadas de `createMultipartUpload` e `abortMultipartUpload` é 3

#### 3.4. ignore-expired-drafts-in-active-limit

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-23T01:07:05Z

**Steps:**
  1. Criar 3 rascunhos e atualizar `upload_expires_at` de um deles para 1 minuto no passado
    - expect: o canal passa a ter 2 uploads ativos
  2. POST /videos com um novo arquivo válido
    - expect: status `201`

#### 3.5. isolate-active-limit-per-channel

**Covers AC:** #4
**Source:** auto
**Last sync:** 2026-11-23T01:07:05Z

**Steps:**
  1. Criar 3 rascunhos com o usuário A
    - expect: status `201` nas 3 chamadas
  2. POST /videos com o token do usuário B
    - expect: status `201`
    - expect: o novo vídeo pertence ao canal do usuário B

#### 3.6. reject-user-without-channel

**Covers AC:** #8
**Source:** auto
**Last sync:** 2026-11-23T01:07:05Z

**Steps:**
  1. Remover do banco o canal do usuário autenticado, mantendo o token válido
    - expect: o usuário não tem canal
  2. POST /videos com body válido
    - expect: status `404`
    - expect: body com `error: "CHANNEL_NOT_FOUND"`
    - expect: `createMultipartUpload` não é chamado
