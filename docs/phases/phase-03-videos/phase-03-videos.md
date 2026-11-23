---
kind: phase
name: phase-03-videos
test_specs_aware: true
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-22T21:39:28-03:00"
  docs/phases/phase-03-videos/library-refs.md: "2026-11-22T21:39:28-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-22T21:39:28-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-11-22T16:12:35-03:00"
---

# Phase 03 — Upload e Processamento de Vídeos

## Objective

Entregar o backend de upload de até 10 GiB, com pré-cadastro automático como rascunho, processamento automático em segundo plano (duração, metadados e thumbnail), URL única por vídeo, reprodução via streaming e download restritos ao dono do canal.

---

## Step Implementations

### SI-03.1 — Infra: Instalar dependências e declarar a configuração

**Description:** Adiciona as bibliotecas fixadas e as variáveis de storage, fila e limite, para que as SIs seguintes consumam configuração validada.

**Technical actions:**

1. Instalar no container, com versão exata, `@aws-sdk/client-sqs@3.1175.0`, `@aws-sdk/client-s3@3.1175.0`, `@aws-sdk/s3-request-presigner@3.1175.0` e `@nestjs/schedule@6.1.3`, mantendo `@nestjs/throttler@^6.5.0` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-04`, `phase-03-videos/TD-08`, `phase-03-videos/TD-17`)
2. Criar `nestjs-project/src/config/storage.config.ts` com `registerAs('storage', ...)` para `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_REGION` e `S3_BUCKET` (per `phase-03-videos/TD-04`, `phase-01-configuracao-base/TD-03`)
3. Criar `nestjs-project/src/config/queue.config.ts` para `SQS_ENDPOINT`, `SQS_REGION`, `SQS_VIDEO_PROCESSING_QUEUE_URL` e `SQS_VIDEO_PROCESSING_DLQ_URL`, e `nestjs-project/src/config/video.config.ts` para `VIDEO_MAX_UPLOAD_BYTES`, com padrão `10737418240` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-05`, `phase-03-videos/TD-16`)
4. Alterar `nestjs-project/src/config/env.validation.ts`: `S3_PUBLIC_ENDPOINT` obrigatório e sem default; `S3_REGION`, `S3_BUCKET`, `SQS_REGION` e as duas URLs de fila obrigatórios; `S3_ENDPOINT`, `SQS_ENDPOINT`, `AWS_ACCESS_KEY_ID` e `AWS_SECRET_ACCESS_KEY` opcionais, para a produção usar a cadeia padrão do SDK (per `phase-03-videos/TD-04`, `phase-01-configuracao-base/TD-02`)
5. Atualizar `nestjs-project/.env.example` e o `.env` local não versionado com `S3_ENDPOINT=http://minio:9000`, `S3_PUBLIC_ENDPOINT=http://localhost:9000`, `SQS_ENDPOINT=http://elasticmq:9324` e as URLs das filas, e registrar os novos namespaces em `ConfigModule.forRoot` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-04`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `envValidationSchema` | Integration: variáveis obrigatórias, opcionais e padrão do limite | `nestjs-project/src/config/env.validation.integration-spec.ts` |

**Dependencies:** none

**Acceptance criteria:**

- A aplicação não inicia sem `S3_PUBLIC_ENDPOINT`, e o erro de configuração cita essa variável
- A aplicação inicia sem `S3_ENDPOINT` e `SQS_ENDPOINT`, condição da produção na AWS
- Sem `VIDEO_MAX_UPLOAD_BYTES`, o limite efetivo é `10737418240` bytes
- `.env.example` contém todas as novas variáveis, sem credenciais de produção

---

### SI-03.2 — Infra: Provisionar MinIO, ElasticMQ e video-worker no Compose

**Description:** Sobe a infraestrutura real da fase e prepara a imagem de desenvolvimento compartilhada com FFmpeg.

**Technical actions:**

1. Criar `nestjs-project/docker/minio/Dockerfile`, com build multi-stage da tag oficial fixada `RELEASE.2025-10-15T17-29-55Z`, usando a versão de Go exigida pelo `go.mod` da tag e incluindo `curl` para o healthcheck (per `phase-03-videos/TD-02`)
2. Adicionar o serviço `minio` ao `nestjs-project/compose.yaml`, com porta `127.0.0.1:9000:9000`, volume nomeado, credenciais `${AWS_ACCESS_KEY_ID}` e `${AWS_SECRET_ACCESS_KEY}`, `MINIO_API_CORS_ALLOW_ORIGIN=http://localhost:3001`, `MINIO_API_STALE_UPLOADS_EXPIRY=72h` e healthcheck (per `phase-03-videos/TD-02`, `phase-03-videos/TD-05`, `phase-03-videos/TD-08`)
3. Criar `nestjs-project/docker/elasticmq/elasticmq.conf` e o serviço `elasticmq` com a imagem `softwaremill/elasticmq-native:1.7.1`, `messages-storage` em H2 no `/data` com volume nomeado, filas `video-processing` e `video-processing-test`, DLQs correspondentes, `maxReceiveCount = 4` e visibilidade de 120s (per `phase-03-videos/TD-01`, `phase-03-videos/TD-15`, `phase-03-videos/TD-16`)
4. Alterar `nestjs-project/Dockerfile.dev` para instalar `ffmpeg` no Debian bookworm, mantendo a imagem única de `nestjs-api` e `video-worker` (per `phase-03-videos/TD-10`, `phase-03-videos/TD-11`)
5. Adicionar o serviço `video-worker` com o mesmo `Dockerfile.dev`, o mesmo volume do código e um comando ocioso provisório, substituído na SI-03.10 quando o processo existir, com `depends_on` em `db`, `minio` e `elasticmq`, e incluir `minio` e `elasticmq` no `depends_on` do `nestjs-api` (per `phase-03-videos/TD-10`)

**Tests:** _(empty — Infra)_

**Dependencies:** SI-03.1 — o Compose lê as credenciais e variáveis declaradas no `.env`

**Acceptance criteria:**

- `docker compose ps` mostra `minio` e `db` saudáveis, e `elasticmq`, `nestjs-api` e `video-worker` em execução
- `ffmpeg -version` e `ffprobe -version` retornam 5.1.x em `nestjs-api` e em `video-worker`
- A porta `9000` do MinIO aceita conexões em `127.0.0.1` e não fica publicada em outras interfaces do host
- Uma mensagem enviada ao ElasticMQ continua disponível após `docker compose restart elasticmq`
- Subir o ambiente não inicia o servidor da API

---

### SI-03.3 — Infra: Isolar o ambiente de testes em `streamtube_test`

**Description:** Cria banco, bucket e filas dedicados, para a suíte não atuar sobre os dados de desenvolvimento nem disputar com o `video-worker`.

**Technical actions:**

1. Criar `nestjs-project/src/test/test-env.setup.ts`, carregado antes de `dotenv/config`, definindo `DB_NAME` e `DB_DATABASE` como `streamtube_test`, `S3_BUCKET=streamtube-test` e as URLs das filas de teste (per `phase-03-videos/TD-16`)
2. Criar `nestjs-project/src/test/test-infrastructure.ts` com `ensureTestDatabase()`, que consulta `pg_database` e tolera o erro `42P04`, e `ensureTestBucket()`, ambos idempotentes e recusando nomes diferentes dos recursos de teste (per `phase-03-videos/TD-16`)
3. Criar `nestjs-project/src/test/migration-list.ts` com `ALL_MIGRATIONS`, fora de `src/database/migrations/` para não ser capturado pelo glob do `data-source.ts`, e `nestjs-project/src/test/global-setup.ts`, que importa `test-env.setup.ts` antes de carregar o `.env`, porque o `globalSetup` do Jest não executa `setupFiles`, e então garante banco e bucket e aplica as migrations
4. Configurar `setupFiles` e `globalSetup` no Jest de `nestjs-project/package.json` e em `nestjs-project/test/jest-e2e.json`, com `test-env.setup.ts` antes de `dotenv/config`
5. Alterar `createTestDataSource` para exigir `DB_DATABASE=streamtube_test`, removendo o fallback para `streamtube` (per `phase-03-videos/TD-16`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `ensureTestDatabase`, `ensureTestBucket` | Integration: idempotência e recusa de recursos fora do ambiente de teste | `nestjs-project/src/test/test-infrastructure.integration-spec.ts` |

**Dependencies:** SI-03.2 — banco, MinIO e ElasticMQ precisam estar disponíveis

**Acceptance criteria:**

- Executar a suíte duas vezes seguidas, inclusive em um volume PostgreSQL já existente, não gera erro de criação do banco
- Após a suíte, o banco `streamtube` mantém a mesma contagem de registros de antes da execução
- Com `DB_DATABASE` diferente de `streamtube_test`, a suíte aborta antes de executar qualquer limpeza
- O `globalSetup` aplica as migrations somente em `streamtube_test`, mesmo com `DB_NAME=streamtube` no `.env`
- O bucket `streamtube-test` existe ao iniciar a suíte, e o bucket de desenvolvimento não recebe objetos de teste

---

### SI-03.4 — Criar a entidade Video e sua migration

**Description:** Materializa a tabela `videos` ligada ao canal e atualiza os helpers de teste afetados pela nova FK.

**Technical actions:**

1. Criar `nestjs-project/src/videos/entities/video.entity.ts` e `video-status.enum.ts` conforme `### Data Model → Video`, com índices parciais e transformer de `bigint`, e declarar `Channel.videos` com `@OneToMany` em `channel.entity.ts` (per `phase-03-videos/TD-14`, `phase-03-videos/TD-18`)
2. Gerar a migration pela CLI com `docker compose exec nestjs-api npm run migration:generate -- src/database/migrations/CreateVideos`, revisar o SQL e o `down`, e aplicá-la com `npm run migration:run`
3. Alterar `cleanAllTables` em `nestjs-project/src/test/create-test-data-source.ts` para limpar `videos` antes de `channels`, e adicionar a migration a `ALL_MIGRATIONS`
4. Adicionar `Video` às listas de entidades das suítes que usam `Channel` com `createTestDataSource`, pois a relação bidirecional exige os dois metadados
5. Atualizar `nestjs-project/src/database/migrations.integration-spec.ts`: importar a migration, incluir `videos` em `MANAGED_TABLES`, remover tabelas em sequência com `videos` primeiro, remover o tipo `videos_status_enum`, esperar 3 migrations e 5 tabelas, e validar que reverter a última remove somente `videos`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `Video` | Integration: FK, `slug` único, default `draft`, enum, `upload_id` com `select: false` e `bigint` | `nestjs-project/src/videos/entities/video.entity.integration-spec.ts` |
| Migrations | Integration: aplicar e reverter a nova migration | `nestjs-project/src/database/migrations.integration-spec.ts` |

**Dependencies:** SI-03.3 — a migration e os helpers usam o banco de testes isolado

**Acceptance criteria:**

- Inserir um vídeo sem `status` persiste `draft`
- Inserir dois vídeos com o mesmo `slug` é rejeitado pelo banco
- Inserir um vídeo com `channel_id` inexistente é rejeitado pelo banco
- Remover um canal que tem vídeos é rejeitado pelo banco
- Consultar um vídeo sem seleção explícita não retorna `upload_id`
- Reverter a migration remove `videos` e `videos_status_enum`, preservando as tabelas de usuários, canais e tokens

---

### SI-03.5 — Implementar o StorageModule

**Description:** Isola o acesso ao S3/MinIO em um módulo próprio, com clientes separados para operações internas e URLs públicas.

**Technical actions:**

1. Criar `nestjs-project/src/storage/storage-keys.ts` com `videoSourceKey(videoId)` e `videoThumbnailKey(videoId)`, gerando `videos/{videoId}/source` e `videos/{videoId}/thumbnail.jpg` (per `phase-03-videos/TD-03`)
2. Criar os providers do cliente interno (`S3_ENDPOINT`) e do cliente de presign (`S3_PUBLIC_ENDPOINT`), ambos com `forcePathStyle: true`, e o de presign com `requestChecksumCalculation: 'WHEN_REQUIRED'` (per `phase-03-videos/TD-04`)
3. Criar `nestjs-project/src/storage/storage.service.ts` com multipart (`createMultipartUpload`, `listAllParts` paginado, `completeMultipartUpload`, `abortMultipartUpload`) e objetos (`headObject`, `putObject`, `deleteObject`), tratando ausência como resultado explícito (per `phase-03-videos/TD-05`, `phase-03-videos/TD-07`, `phase-03-videos/TD-18`)
4. Adicionar assinatura: `signUploadPart` com `Content-Length` em `signableHeaders` e validade de 1 hora, `signPublicGetObject` com `ResponseContentType` e `ResponseContentDisposition`, e `signInternalGetObject` para o worker (per `phase-03-videos/TD-05`, `phase-03-videos/TD-11`, `phase-03-videos/TD-13`)
5. Criar `nestjs-project/src/storage/storage.module.ts`, exportando apenas `StorageService`, e o script idempotente `storage:setup`, que cria o bucket e aplica `PutBucketCors` com `ExposeHeaders: ['ETag']` somente em S3 real (per `phase-03-videos/TD-05`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `storage-keys` | Unit: formato das chaves, sem nome original | `nestjs-project/src/storage/storage-keys.spec.ts` |
| `StorageService` | Integration: multipart real, `Content-Length` assinado, Range/206, `Host` público e remoção idempotente | `nestjs-project/src/storage/storage.service.integration-spec.ts` |
| `StorageModule` | Unit: compilação do módulo | `nestjs-project/src/storage/storage.module.spec.ts` |

**Dependencies:** SI-03.1, SI-03.3

**Acceptance criteria:**

- Uma URL de `UploadPart` rejeita corpo com tamanho diferente do `Content-Length` assinado
- Uma URL de `UploadPart` assinada não contém parâmetros de checksum automático
- Uma URL pública usa o host de `S3_PUBLIC_ENDPOINT` e aceita conexão a `minio:9000` com `Host: localhost:9000`
- Um `GET` com `Range` em URL assinada retorna `206` com o intervalo pedido
- O preflight CORS de `http://localhost:3001` expõe o header `ETag`
- Remover um objeto inexistente termina sem erro

---

### SI-03.6 — Implementar o QueueModule

**Description:** Encapsula o SQS/ElasticMQ em um módulo próprio, com as operações de envio, consumo, visibilidade e DLQ.

**Technical actions:**

1. Criar o provider de `SQSClient` em `nestjs-project/src/queue/`, usando `SQS_ENDPOINT` apenas quando definido (per `phase-03-videos/TD-01`)
2. Criar `nestjs-project/src/queue/video-processing-queue.service.ts` com `enqueue(videoId)` e `receive()` por long polling, retornando no máximo 1 mensagem com `ApproximateReceiveCount` (per `phase-03-videos/TD-01`, `phase-03-videos/TD-10`)
3. Adicionar `changeVisibility` e `delete` para heartbeat, backoff e confirmação (per `phase-03-videos/TD-15`)
4. Adicionar `receiveDeadLetter` e `deleteDeadLetter`, validando o payload `{ videoId }` de `### Events/Messages` (per `phase-03-videos/TD-15`)
5. Criar `nestjs-project/src/queue/queue.module.ts`, exportando apenas `VideoProcessingQueueService`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessingQueueService` | Integration: envio, recebimento, visibilidade, exclusão e redrive com ElasticMQ real, usando `PurgeQueue` nas filas de teste | `nestjs-project/src/queue/video-processing-queue.service.integration-spec.ts` |
| `QueueModule` | Unit: compilação do módulo | `nestjs-project/src/queue/queue.module.spec.ts` |

**Dependencies:** SI-03.1, SI-03.3

**Acceptance criteria:**

- Uma mensagem enviada é recebida com o payload `{ videoId }`
- Uma mensagem recebida e não confirmada volta à fila quando a visibilidade termina
- Ajustar a visibilidade adia a próxima entrega pelo tempo informado
- Uma mensagem recebida 4 vezes sem confirmação passa para a DLQ
- Uma mensagem excluída não é entregue novamente

---

### SI-03.7 — Endpoint POST /videos

**Route:** POST /videos
**Test Specs:** see `nestjs-project/specs/videos-create.plan.md`
**Authorization:** Authenticated, no próprio canal

**Description:** Inicia o multipart e cria o rascunho em uma única chamada, com slug único e limite de uploads ativos por canal.

**Technical actions:**

1. Criar `nestjs-project/src/videos/video-slug.util.ts` com slug base62 de 11 caracteres via `node:crypto`, e `nestjs-project/src/videos/video.exceptions.ts` com os erros de `### Error Catalog` estendendo `DomainException` (per `phase-03-videos/TD-09`, `phase-02-auth/TD-07`)
2. Adicionar a `ChannelsService` a busca do canal pelo usuário e o bloqueio `FOR UPDATE` dentro de uma transação recebida, mantendo a regra de canal em seu módulo (per `phase-03-videos/TD-17`)
3. Criar `VideoUploadsService.startUpload` em `nestjs-project/src/videos/video-uploads.service.ts`: validar o limite de tamanho, checar uploads ativos, criar o multipart e, em transação, bloquear o canal, recontar e inserir o rascunho com `upload_expires_at` de 48h, usando `SAVEPOINT` por tentativa de slug e abortando o multipart em qualquer falha (per `phase-03-videos/TD-05`, `phase-03-videos/TD-06`, `phase-03-videos/TD-08`, `phase-03-videos/TD-09`, `phase-03-videos/TD-17`)
4. Criar `CreateVideoDto`, o DTO de resposta, `nestjs-project/src/videos/video-throttle.constants.ts` com a tabela do TD-17 e o `getTracker` por `req.user.sub`, e `POST /videos` em `videos.controller.ts`, conforme `### API Contracts → POST /videos` (per `phase-03-videos/TD-17`)
5. Criar `nestjs-project/src/videos/videos.module.ts` com `TypeOrmModule.forFeature([Video])`, `ChannelsModule`, `StorageModule` e `QueueModule`, e registrá-lo em `AppModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `video-slug.util` | Unit: tamanho, alfabeto base62 | `nestjs-project/src/videos/video-slug.util.spec.ts` |
| `VideoUploadsService` | Unit: limite, canal ausente e abort em falha | `nestjs-project/src/videos/video-uploads.service.spec.ts` |
| `VideoUploadsService` | Integration: rascunho real, limite reduzido por `VIDEO_MAX_UPLOAD_BYTES`, colisão de slug e concorrência no limite de 3 uploads | `nestjs-project/src/videos/video-uploads.service.integration-spec.ts` |
| `VideosModule` | Unit: compilação do módulo | `nestjs-project/src/videos/videos.module.spec.ts` |

**Dependencies:** SI-03.4, SI-03.5, SI-03.6

**Acceptance criteria:**

- `POST /videos` com `filename` e `sizeBytes` válidos retorna `201` com `id`, `slug`, `status: draft`, `partSizeBytes`, `partCount` e `uploadExpiresAt`
- `POST /videos` com `sizeBytes: 10737418240` retorna `201` e `partCount: 640`
- `POST /videos` com `sizeBytes: 10737418241` retorna `413 VIDEO_TOO_LARGE`, sem criar registro nem multipart
- Com 3 uploads ativos no canal, `POST /videos` retorna `409 ACTIVE_UPLOAD_LIMIT_REACHED` e não deixa multipart aberto
- Quatro `POST /videos` simultâneos no mesmo canal criam no máximo 3 rascunhos
- Uma falha ao persistir o rascunho aborta o multipart criado
- A chave do objeto não contém o nome original do arquivo
- Um usuário autenticado sem canal recebe `404 CHANNEL_NOT_FOUND`, sem criar multipart

---

### SI-03.8 — Endpoints de assinatura de partes e retomada

**Route:** POST /videos/:id/upload/part-urls; GET /videos/:id/upload/parts
**Test Specs:** see `nestjs-project/specs/videos-upload-parts.plan.md`
**Authorization:** Owner

**Description:** Permite enviar as partes diretamente ao storage e retomar um upload interrompido.

**Technical actions:**

1. Adicionar a `VideoUploadsService` a carga do rascunho por `id` e dono, com `upload_id`, respondendo `VIDEO_NOT_FOUND`, `UPLOAD_NOT_ACTIVE` ou `UPLOAD_EXPIRED` (per `phase-03-videos/TD-05`, `phase-03-videos/TD-08`)
2. Implementar `signParts`: validar cada número contra `part_count`, calcular o `contentLength` real, inclusive da última parte, e assinar o lote com validade de 1 hora (per `phase-03-videos/TD-05`)
3. Implementar `listUploadedParts` com todas as páginas de `ListParts` (per `phase-03-videos/TD-05`)
4. Criar `SignPartsDto` e os DTOs de resposta, e adicionar as duas rotas a `VideosController`, com `ParseUUIDPipe` e `@Throttle` conforme o TD-17 (per `phase-03-videos/TD-17`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoUploadsService` | Unit: cálculo da última parte, número inválido e estados do rascunho | `nestjs-project/src/videos/video-uploads.service.spec.ts` |
| `VideoUploadsService` | Integration: assinatura, envio real e retomada por `ListParts` | `nestjs-project/src/videos/video-uploads.service.integration-spec.ts` |

**Dependencies:** SI-03.7

**Acceptance criteria:**

- `POST /videos/:id/upload/part-urls` com até 50 partes válidas retorna `201` com `parts` e `expiresAt` em 1 hora
- O `contentLength` da última parte corresponde ao restante do arquivo
- `POST /videos/:id/upload/part-urls` com 51 partes retorna `400`
- Um `partNumber` maior que `partCount` retorna `400 INVALID_PART_NUMBER`
- `GET /videos/:id/upload/parts` retorna as partes já enviadas com `partNumber`, `sizeBytes` e `etag`
- As duas rotas retornam `404 VIDEO_NOT_FOUND` para um vídeo de outro canal
- As duas rotas retornam `410 UPLOAD_EXPIRED` após `upload_expires_at`

---

### SI-03.9 — Endpoint de conclusão do upload

**Route:** POST /videos/:id/upload/complete
**Test Specs:** see `nestjs-project/specs/videos-upload-complete.plan.md`
**Authorization:** Owner

**Description:** Valida o tamanho real, conclui o objeto e inicia o processamento de forma idempotente.

**Technical actions:**

1. Implementar a validação prévia em `VideoUploadsService.completeUpload`: comparar `ListParts` com as partes enviadas e o tamanho declarado, respondendo `UPLOAD_INCOMPLETE` e mantendo o rascunho retomável (per `phase-03-videos/TD-07`)
2. Chamar `CompleteMultipartUpload` e conferir `HeadObject`; tratar `NoSuchUpload` seguido de `HeadObject` correto como nova tentativa válida (per `phase-03-videos/TD-07`)
3. Em divergência após a conclusão, remover o objeto e gravar `failed`, `failure_code = SIZE_MISMATCH` e `storage_purged_at`, respondendo `VIDEO_SIZE_MISMATCH` (per `phase-03-videos/TD-07`, `phase-03-videos/TD-18`)
4. Fazer commit de `draft → processing` com `size_bytes`, `job_enqueued_at` nulo e `upload_id` nulo, chamar `enqueue` e então preencher `job_enqueued_at`; uma falha no envio é registrada em log e fica para o reconciliador (per `phase-03-videos/TD-14`)
5. Criar `CompleteUploadDto` e a rota com status `202`, retornando `202` para vídeo já em `processing` ou `ready` (per `phase-03-videos/TD-07`, `phase-03-videos/TD-17`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoUploadsService` | Unit: divergências, idempotência e falha no envio à fila | `nestjs-project/src/videos/video-uploads.service.spec.ts` |
| `VideoUploadsService` | Integration: conclusão real, `NoSuchUpload` + `HeadObject`, transição e mensagem na fila | `nestjs-project/src/videos/video-uploads.service.integration-spec.ts` |

**Dependencies:** SI-03.8

**Acceptance criteria:**

- `POST /videos/:id/upload/complete` com todas as partes retorna `202` com `status: processing` e publica `{ videoId }` na fila
- Repetir a chamada após uma resposta perdida retorna `202` sem publicar nova mensagem
- Com partes faltando, a rota retorna `409 UPLOAD_INCOMPLETE`, e o vídeo continua em `draft`
- Com tamanho final divergente, a rota retorna `422 VIDEO_SIZE_MISMATCH`, o objeto é removido e o vídeo fica em `failed`
- Se a fila estiver indisponível após o commit, a rota retorna `202` e o vídeo fica em `processing` com `job_enqueued_at` nulo
- A rota retorna `410 UPLOAD_EXPIRED` após `upload_expires_at`

---

### SI-03.10 — Infra: Criar o processo video-worker

**Description:** Adiciona um segundo ponto de entrada no mesmo projeto NestJS, sem servidor HTTP e sem conflito de build com a API.

**Technical actions:**

1. Extrair `ConfigModule` e `TypeOrmModule.forRootAsync` de `AppModule` para `nestjs-project/src/database/database.module.ts`, reutilizando o `databaseConfig` nos dois processos (per `phase-01-configuracao-base/TD-04`)
2. Criar `nestjs-project/src/video-worker/video-worker.module.ts` com `DatabaseModule`, `ScheduleModule.forRoot()`, `StorageModule`, `QueueModule` e `TypeOrmModule.forFeature([Video])` (per `phase-03-videos/TD-10`, `phase-03-videos/TD-08`)
3. Criar `nestjs-project/src/worker.ts` com `NestFactory.createApplicationContext` e `enableShutdownHooks` (per `phase-03-videos/TD-10`)
4. Criar `nestjs-project/tsconfig.worker.json` com `outDir: ./dist-worker`, pois API e worker compartilham o volume e `deleteOutDir` apagaria o `dist` do outro processo, e adicionar `/dist-worker` ao `.gitignore`
5. Adicionar os scripts `start:worker:dev` e `start:worker` ao `nestjs-project/package.json` e trocar o comando do serviço `video-worker` no `compose.yaml` para aguardar `node_modules` e executar `start:worker:dev`, com `restart: unless-stopped`, para o worker subir no `docker compose up` (requisito do desafio; per `phase-03-videos/TD-10`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `DatabaseModule` | Unit: compilação do módulo | `nestjs-project/src/database/database.module.spec.ts` |
| `VideoWorkerModule` | Unit: compilação do módulo | `nestjs-project/src/video-worker/video-worker.module.spec.ts` |

**Dependencies:** SI-03.5, SI-03.6

**Acceptance criteria:**

- `docker compose up -d` inicia o processo do worker no serviço `video-worker`, sem abrir porta HTTP
- Em um ambiente sem `node_modules`, o worker aguarda o `npm install` e inicia sem intervenção manual
- API e worker em modo watch funcionam ao mesmo tempo, sem um apagar a saída de build do outro
- Ao receber `SIGTERM`, o worker encerra as conexões com banco e fila
- As rotas existentes da API continuam respondendo após a extração do `DatabaseModule`

---

### SI-03.11 — Implementar a extração com FFmpeg

**Description:** Extrai metadados e thumbnail por leitura parcial, com validação de formato e proteção contra arquivos maliciosos.

**Technical actions:**

1. Criar `nestjs-project/src/video-worker/ffmpeg.service.ts`, executando `ffprobe` e `ffmpeg` com `child_process` sem shell e sem `fluent-ffmpeg`, usando apenas opções do FFmpeg 5.1.9 (per `phase-03-videos/TD-10`, `phase-03-videos/TD-11`)
2. Aplicar `-protocol_whitelist` restrito, timeout e redação da URL pré-assinada em logs e erros (per `phase-03-videos/TD-11`)
3. Implementar `probe(url)`, retornando duração, dimensões, contêiner, codecs e `pix_fmt`, e conferir o DocType EBML `webm` nos primeiros bytes, porque o ffprobe informa MKV e WebM com o mesmo `format_name` (per `phase-03-videos/TD-11`, `phase-03-videos/TD-12`)
4. Criar `nestjs-project/src/video-worker/media-allowlist.ts` com a matriz do `phase-03-videos/TD-12` Option A, sem transcodificação, exigindo `pix_fmt` `yuv420p` ou `yuvj420p` e áudio opcional: MP4/MOV com `h264` e `aac` ou `mp3`, como `video/mp4`; WebM com `vp8`, `vp9` ou `av1` e `opus` ou `vorbis`, como `video/webm`. Arquivo ilegível ou fora da matriz é `UNSUPPORTED_FORMAT` (per `phase-03-videos/TD-12`, `phase-03-videos/TD-13`, `phase-03-videos/TD-15`)
5. Implementar `extractThumbnail(url, durationSeconds)` com frame em 10% da duração e fallback para o primeiro frame (per `phase-03-videos/TD-11`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `media-allowlist` | Unit: cada combinação aceita e recusas por contêiner, codec e `pix_fmt` | `nestjs-project/src/video-worker/media-allowlist.spec.ts` |
| `FfmpegService` | Unit: argumentos, redação de URL e classificação de erro | `nestjs-project/src/video-worker/ffmpeg.service.spec.ts` |
| `FfmpegService` | Integration: fixtures geradas por FFmpeg, MP4 com `moov` no final e leitura parcial no MinIO | `nestjs-project/src/video-worker/ffmpeg.service.integration-spec.ts` |

**Dependencies:** SI-03.5, SI-03.10

**Acceptance criteria:**

- Um MP4 válido com `moov` no final tem duração, dimensões e codecs extraídos sem baixar o objeto inteiro
- A thumbnail gerada é um JPEG válido do frame em 10% da duração
- Um vídeo curto demais para esse ponto gera thumbnail a partir do primeiro frame
- Um MP4 H.264 + AAC em `yuvj420p` é aceito como `video/mp4`, e um WebM VP9 + Opus é aceito como `video/webm`
- WebM com H.264, H.264 em `yuv420p10le` e MKV com VP9 são classificados como `UNSUPPORTED_FORMAT`
- Um arquivo que referencia outro protocolo não aciona acesso a esse protocolo
- A assinatura da URL não aparece em logs nem em mensagens de erro

---

### SI-03.12 — Implementar o processamento e o consumidor da fila

**Description:** Conclui o ciclo `processing → ready` ou `failed`, com entrega at-least-once e handler idempotente.

**Technical actions:**

1. Criar `nestjs-project/src/video-worker/video-processor.service.ts`: conferir o status ao iniciar, assinar a URL interna, extrair metadados, validar a allowlist e gravar `videos/{videoId}/thumbnail.jpg` (per `phase-03-videos/TD-03`, `phase-03-videos/TD-11`, `phase-03-videos/TD-15`)
2. Gravar `processing → ready` em um único `UPDATE ... WHERE status = 'processing'`, com duração, metadados, `content_type` e `thumbnail_key` (per `phase-03-videos/TD-14`, `phase-03-videos/TD-15`)
3. Em erro permanente, gravar `failed`, `failure_code` e `storage_purge_after = now()` no mesmo `UPDATE`, e confirmar a mensagem (per `phase-03-videos/TD-15`, `phase-03-videos/TD-18`)
4. Criar `nestjs-project/src/video-worker/video-processing.consumer.ts` com long polling, 1 job por réplica, heartbeat de 40s, limite de 30 minutos e encerramento gracioso (per `phase-03-videos/TD-10`, `phase-03-videos/TD-15`)
5. Em erro transitório, ajustar a visibilidade para 30s, 60s e 120s conforme `ApproximateReceiveCount`; apagar sem processar a mensagem de vídeo fora de `processing` (per `phase-03-videos/TD-15`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoProcessorService` | Unit: ramos de status e classificação de erro | `nestjs-project/src/video-worker/video-processor.service.spec.ts` |
| `VideoProcessorService` | Integration: fluxo real até `ready`, formato recusado e duplicata | `nestjs-project/src/video-worker/video-processor.service.integration-spec.ts` |
| `VideoProcessingConsumer` | Unit: heartbeat, backoff, limite de execução e shutdown | `nestjs-project/src/video-worker/video-processing.consumer.spec.ts` |
| `VideoProcessingConsumer` | Integration: mensagem real na fila de teste do ElasticMQ, objeto no MinIO e FFmpeg até `ready` | `nestjs-project/src/video-worker/video-processing.consumer.integration-spec.ts` |

**Dependencies:** SI-03.9, SI-03.11

**Acceptance criteria:**

- Uma mensagem de vídeo válido leva o vídeo a `ready`, com duração, metadados e `thumbnail_key` gravados juntos
- Com ElasticMQ, MinIO e FFmpeg reais, o consumidor processa uma mensagem da fila de teste até `ready` e a remove da fila
- Um formato não aceito leva o vídeo a `failed` com `UNSUPPORTED_FORMAT` e `storage_purge_after` igual ao momento da falha
- Uma mensagem duplicada não altera um vídeo já em `ready`
- Um erro transitório devolve a mensagem à fila com atraso de 30s, 60s e 120s nas tentativas seguintes
- Durante uma execução longa, a mensagem não fica visível para outro consumidor
- Uma execução acima de 30 minutos é interrompida e tratada como erro transitório

---

### SI-03.13 — Implementar o reconciliador e o consumidor da DLQ

**Description:** Evita vídeos presos em `processing` e registra as falhas que esgotaram as retentativas.

**Technical actions:**

1. Criar `nestjs-project/src/video-worker/video-reconciler.service.ts` com job agendado e seleção por `FOR UPDATE SKIP LOCKED`, registrando falhas em log sem encerrar o processo, inclusive antes de as migrations serem aplicadas (per `phase-03-videos/TD-14`)
2. Reenviar vídeos em `processing` com `job_enqueued_at` nulo há mais de 1 minuto, usando `updated_at` como referência, ou com `job_enqueued_at` anterior a 2h30 (per `phase-03-videos/TD-14`)
3. Atualizar `job_enqueued_at` a cada reenvio (per `phase-03-videos/TD-14`)
4. Criar `nestjs-project/src/video-worker/video-dlq.consumer.ts`, que grava `failed`, `PROCESSING_EXHAUSTED` e `storage_purge_after` em agora + 7 dias somente para vídeos em `processing`, e então apaga a mensagem (per `phase-03-videos/TD-15`, `phase-03-videos/TD-18`)
5. Registrar os dois providers em `VideoWorkerModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoReconcilerService` | Integration: critérios de reenvio e réplicas concorrentes | `nestjs-project/src/video-worker/video-reconciler.service.integration-spec.ts` |
| `VideoDlqConsumer` | Integration: transição, retenção e idempotência | `nestjs-project/src/video-worker/video-dlq.consumer.integration-spec.ts` |

**Dependencies:** SI-03.12

**Acceptance criteria:**

- Um vídeo em `processing` com `job_enqueued_at` nulo há mais de 1 minuto recebe nova mensagem
- Um vídeo com `job_enqueued_at` há menos de 2h30 não recebe nova mensagem
- Um vídeo com `job_enqueued_at` anterior a 2h30 recebe nova mensagem e tem o campo atualizado
- Duas execuções simultâneas do reconciliador não reenviam o mesmo vídeo
- Sem a tabela `videos`, o reconciliador registra o erro e o worker continua em execução
- Uma mensagem na DLQ leva o vídeo a `failed` com `PROCESSING_EXHAUSTED` e purge em 7 dias
- Uma mensagem na DLQ de vídeo já em `ready` não altera o vídeo

---

### SI-03.14 — Endpoints de consulta, streaming e download

**Route:** GET /videos/:slug; GET /videos/:slug/playback; GET /videos/:slug/download
**Test Specs:** see `nestjs-project/specs/videos-access.plan.md`
**Authorization:** Owner

**Description:** Expõe o vídeo pela URL única e entrega streaming e download por URLs pré-assinadas, restritos ao dono.

**Technical actions:**

1. Criar `nestjs-project/src/videos/videos.service.ts` com a busca por `slug` e dono, respondendo `VIDEO_NOT_FOUND` também para slug malformado e vídeo de outro canal (per `phase-03-videos/TD-09`, `phase-03-videos/TD-13`)
2. Implementar `getVideo`, com `thumbnailUrl` pré-assinada de 1 hora somente em `ready` (per `phase-03-videos/TD-03`, `phase-03-videos/TD-13`)
3. Implementar `getPlayback` com `ResponseContentDisposition: inline` e validade `min(7 dias, max(1h, 2 × duração))` (per `phase-03-videos/TD-13`)
4. Implementar `getDownload` com `attachment`, nome sanitizado e validade de 6 horas; as duas operações respondem `VIDEO_NOT_READY` fora de `ready` (per `phase-03-videos/TD-13`, `phase-03-videos/TD-18`)
5. Adicionar as três rotas a `VideosController`, com DTOs de resposta e `@Throttle` conforme o TD-17 (per `phase-03-videos/TD-17`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideosService` | Unit: autorização, status, teto de 7 dias e sanitização do nome | `nestjs-project/src/videos/videos.service.spec.ts` |
| `VideosService` | Integration: URLs reais com Range/206 e headers assinados | `nestjs-project/src/videos/videos.service.integration-spec.ts` |

**Dependencies:** SI-03.5, SI-03.12

**Acceptance criteria:**

- `GET /videos/:slug` retorna `200` com status, metadados e `thumbnailUrl` para o dono de um vídeo em `ready`
- `GET /videos/:slug/playback` retorna `{ url, expiresAt }`, e a URL atende `Range` com `206`
- A validade de playback de um vídeo com mais de 84 horas é de exatamente 7 dias
- `GET /videos/:slug/download` retorna uma URL cuja resposta traz `Content-Disposition: attachment` com nome sanitizado
- Playback e download de vídeo fora de `ready` retornam `409 VIDEO_NOT_READY`
- Um usuário que não é dono recebe `404 VIDEO_NOT_FOUND` nas três rotas
- Uma requisição sem token recebe `401` nas três rotas

---

### SI-03.15 — Implementar a limpeza e a retenção do storage

**Description:** Remove uploads abandonados e objetos de vídeos em falha conforme a classe do erro.

**Technical actions:**

1. Criar `nestjs-project/src/video-worker/video-cleanup.service.ts` com `@Cron` e `waitForCompletion`, depois de confirmar essa opção nos tipos da versão `6.1.3`, registrando falhas em log sem encerrar o processo (per `phase-03-videos/TD-08`)
2. Selecionar rascunhos com `upload_expires_at` vencido por `FOR UPDATE SKIP LOCKED` (per `phase-03-videos/TD-08`)
3. Para cada rascunho, chamar `AbortMultipartUpload` e `DeleteObject` em `videos/{videoId}/source`, tolerando ausência, e só então apagar o registro (per `phase-03-videos/TD-08`)
4. Selecionar vídeos `failed` com `storage_purge_after` vencido e `storage_purged_at` nulo, remover `source` e `thumbnail.jpg`, e só então preencher `storage_purged_at` (per `phase-03-videos/TD-18`)
5. Registrar o provider em `VideoWorkerModule`

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| `VideoCleanupService` | Unit: falha em um item não interrompe o lote | `nestjs-project/src/video-worker/video-cleanup.service.spec.ts` |
| `VideoCleanupService` | Integration: rascunhos, objetos órfãos, retenção e réplicas concorrentes | `nestjs-project/src/video-worker/video-cleanup.service.integration-spec.ts` |

**Dependencies:** SI-03.10, SI-03.13

**Acceptance criteria:**

- Um rascunho expirado com multipart aberto tem o upload abortado e o registro removido
- Um rascunho expirado com `source` já concluído tem o objeto e o registro removidos
- Um rascunho dentro da validade permanece intacto
- Um vídeo `failed` com `PROCESSING_EXHAUSTED` mantém os objetos durante os 7 dias
- Um vídeo `failed` vencido tem `source` e thumbnail removidos e `storage_purged_at` preenchido
- Se a execução cair entre a remoção e o `UPDATE`, a execução seguinte conclui sem erro

---

### SI-03.16 — Proteger os limites e a ordem dos guards

**Description:** Garante por teste e2e que `JwtAuthGuard` roda antes de `ThrottlerGuard` e que os limites por usuário valem nas rotas de vídeo.

**Technical actions:**

1. Criar `nestjs-project/test/videos-throttling.e2e-spec.ts` com os guards reais, sem sobrescrever `JwtAuthGuard` nem `ThrottlerGuard` (per `phase-03-videos/TD-17`)
2. Cobrir chamadas sem token, que devem receber `401` sem consumir o contador do usuário e nunca `500` (per `phase-03-videos/TD-17`)
3. Cobrir o limite por usuário e por rota na tabela do TD-17, com dois usuários no mesmo IP (per `phase-03-videos/TD-17`)
4. Cobrir uma rota `@Public()` de autenticação, que mantém 10 requisições por 60s rastreadas por IP, sem alterar `ThrottlerModule.forRoot` (per `phase-03-videos/TD-17`, `phase-02-auth/TD-08`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Ordem `JwtAuthGuard` → `ThrottlerGuard` e limites por usuário | E2E: guards reais via `supertest` | `nestjs-project/test/videos-throttling.e2e-spec.ts` |

**Dependencies:** SI-03.7, SI-03.8, SI-03.9, SI-03.14

**Acceptance criteria:**

- Uma rota de vídeo sem token retorna `401`, inclusive depois de o usuário atingir o próprio limite
- A 11ª chamada a `POST /videos` em 60s pelo mesmo usuário retorna `429`
- Um segundo usuário no mesmo IP não é afetado pelo limite do primeiro
- Atingir o limite de uma rota de vídeo não bloqueia outra rota de vídeo do mesmo usuário
- A 11ª chamada a uma rota pública de autenticação pelo mesmo IP em 60s retorna `429`

---

### SI-03.17 — Documentar os endpoints no OpenAPI

**Description:** Publica o contrato dos sete endpoints de vídeo com decoradores explícitos e atualiza o artefato versionado.

**Technical actions:**

1. Anotar `VideosController` com `@ApiTags('videos')`, `@ApiBearerAuth('access-token')` e `@ApiOperation` em cada rota (per `openapi-docs-nestjs/TD-01`)
2. Declarar `@ApiResponse` para o sucesso e para cada erro de `### API Contracts`, com `getSchemaPath(ApiErrorEnvelope)` nos erros (per `openapi-docs-nestjs/TD-01`, `phase-02-auth/TD-07`)
3. Completar os DTOs de resposta com `@ApiProperty`, incluindo campos anuláveis, sem duplicar nos DTOs de entrada o que o plugin já infere (per `openapi-docs-nestjs/TD-01`)
4. Regenerar `nestjs-project/openapi.json` com `docker compose exec nestjs-api npm run openapi:export` e revisar o diff (per `openapi-docs-nestjs/TD-02`)

**Tests:**

| Artifact | Layer | Test file |
|----------|-------|-----------|
| Documento OpenAPI | Integration: sete rotas, status de sucesso e erro, envelope e segurança | `nestjs-project/src/openapi-export.integration-spec.ts` |

**Dependencies:** SI-03.7, SI-03.8, SI-03.9, SI-03.14

**Acceptance criteria:**

- `openapi.json` contém as sete operações de vídeo com o esquema de segurança `access-token`
- Cada operação documenta o status de sucesso e todos os erros previstos em `### API Contracts`
- As respostas de erro referenciam `ApiErrorEnvelope`
- Regenerar o arquivo sem mudar o código não produz diff
- A Swagger UI continua disponível apenas com `SWAGGER_ENABLED=true`

---

### SI-03.18 — Atualizar os CLAUDE.md e fechar a Definition of Done

**Description:** Requisito do desafio: alinha a documentação operacional ao código entregue e valida a fase com a suíte completa e um smoke test manual. Esta entrega prevalece sobre a nota do research que a classificava como tarefa separada.

**Technical actions:**

1. Atualizar o `CLAUDE.md` da raiz: trocar a fila `TBD` por SQS/ElasticMQ, descrever o `video-worker` e o MinIO, e registrar `S3_PUBLIC_ENDPOINT` como única exceção à regra de Docker Networking (per `phase-03-videos/TD-01`, `phase-03-videos/TD-04`, `phase-03-videos/TD-10`)
2. Atualizar `nestjs-project/CLAUDE.md` com uma seção de vídeos: serviços, readiness, comandos do worker, `storage:setup`, banco `streamtube_test`, filas e bucket de teste, e a regra de que o `video-worker` sobe com o Compose, enquanto o servidor da API continua sob demanda (per `phase-03-videos/TD-10`, `phase-03-videos/TD-16`)
3. Criar `nestjs-project/scripts/smoke-video-upload.ts`, que envia um arquivo por partes em streaming, chamando o MinIO em `minio:9000` com `Host: localhost:9000`, e acompanha o status do vídeo (per `phase-03-videos/TD-16`)
4. Executar a Definition of Done dentro do container: `docker compose exec nestjs-api npm test -- --runInBand`, `docker compose exec nestjs-api npm run test:e2e`, `docker compose exec nestjs-api npx tsc --noEmit` e `docker compose exec nestjs-api npm run lint`
5. Executar o smoke test manual: confirmar com `df -h` ao menos 15 GiB livres no disco do Docker; enviar um vídeo real e validar `ready`, thumbnail, Range e download; depois enviar um arquivo esparso de `10737418240` bytes criado com `truncate`, que não ocupa disco na origem, e validar o tamanho final, o `failed` com `UNSUPPORTED_FORMAT` e a remoção do objeto (per `phase-03-videos/TD-16`, `phase-03-videos/TD-18`)

**Tests:** _(empty — documentação e validação final; a suíte completa e o smoke manual são executados nas ações 4 e 5)_

**Dependencies:** SI-03.15, SI-03.16, SI-03.17

**Acceptance criteria:**

- O `CLAUDE.md` da raiz não descreve mais a fila como `TBD` e registra a exceção de `S3_PUBLIC_ENDPOINT`
- Todo comando novo citado em `nestjs-project/CLAUDE.md` executa com sucesso no serviço indicado
- Após `docker compose up -d`, MinIO, ElasticMQ e o processo do `video-worker` estão em execução, sem iniciar o servidor da API
- A suíte unitária e de integração e a suíte e2e terminam sem falhas dentro do container
- `npx tsc --noEmit` termina com código 0, e `npm run lint` termina sem erros
- Um vídeo real enviado por partes chega a `ready`, reproduz com Range/206 e baixa com o mesmo tamanho do original
- O upload de `10737418240` bytes é concluído com esse tamanho no storage e tem o objeto removido após `UNSUPPORTED_FORMAT`
- O smoke test não é iniciado com menos de 15 GiB livres

---

## Technical Specifications

### Data Model

#### Video

Tabela `videos`, entidade em `nestjs-project/src/videos/entities/video.entity.ts`.

| Field | Type | Constraints |
|-------|------|-------------|
| id | uuid | PK, generated. Referência interna em chaves de storage, mensagens e orquestração do upload (`phase-03-videos/TD-09`) |
| channel_id | uuid | not null, FK `channels(id)` ON DELETE RESTRICT |
| slug | varchar(11) | unique, not null. Base62 gerado com `node:crypto` (`phase-03-videos/TD-09`) |
| status | enum `videos_status_enum` (`draft`, `processing`, `ready`, `failed`) | not null, default `draft`. Status do pipeline, separado da publicação da Fase 04 (`phase-03-videos/TD-14`) |
| original_filename | varchar(255) | not null. Nunca entra na chave do storage (`phase-03-videos/TD-03`) |
| declared_size_bytes | bigint | not null. Tamanho informado ao iniciar, limitado a `10737418240` (`phase-03-videos/TD-05`) |
| size_bytes | bigint | null. Tamanho real do `HeadObject` (`phase-03-videos/TD-07`) |
| part_size_bytes | integer | not null. `16777216` por padrão (`phase-03-videos/TD-05`) |
| part_count | integer | not null. `ceil(declared_size_bytes / part_size_bytes)`, no máximo 640 |
| upload_id | text | null, `select: false`. UploadId do multipart, limpo em `draft → processing` |
| upload_expires_at | timestamptz | null. Criação + 48h (`phase-03-videos/TD-08`) |
| job_enqueued_at | timestamptz | null. Preenchido após `SendMessage` (`phase-03-videos/TD-14`) |
| content_type | varchar(100) | null. Tipo validado pelo ffprobe (`phase-03-videos/TD-13`) |
| duration_seconds | numeric(12,3) | null |
| width | integer | null |
| height | integer | null |
| container | varchar(100) | null |
| video_codec | varchar(50) | null |
| audio_codec | varchar(50) | null |
| thumbnail_key | varchar(255) | null. `videos/{videoId}/thumbnail.jpg` |
| failure_code | varchar(50) | null (`phase-03-videos/TD-18`) |
| storage_purge_after | timestamptz | null (`phase-03-videos/TD-18`) |
| storage_purged_at | timestamptz | null (`phase-03-videos/TD-18`) |
| created_at | timestamptz | `@CreateDateColumn` |
| updated_at | timestamptz | `@UpdateDateColumn` |

**Relations:** `Channel` has many `Video` (one-to-many). Os dois lados são declarados, conforme a regra de entidades do projeto.
**Indexes:** unique em `slug`; parcial em `channel_id` e parcial em `upload_expires_at` com `WHERE status = 'draft'`; parcial em `job_enqueued_at` com `WHERE status = 'processing'`; parcial em `storage_purge_after` com `WHERE status = 'failed' AND storage_purged_at IS NULL`.
**Storage keys (`phase-03-videos/TD-03`, `phase-03-videos/TD-18`):** `videos/{videoId}/source` e `videos/{videoId}/thumbnail.jpg`, em um bucket privado.
**Bigint:** `declared_size_bytes` e `size_bytes` usam transformer para `number`. O limite de 10 GiB está dentro de `Number.MAX_SAFE_INTEGER`.

**Transições de status (`phase-03-videos/TD-07`, `phase-03-videos/TD-14`, `phase-03-videos/TD-15`, `phase-03-videos/TD-18`):**

| De | Para | Quem executa | Condição |
|----|------|--------------|----------|
| — | `draft` | API | `POST /videos` |
| `draft` | `processing` | API | Conclusão com tamanho válido; grava `job_enqueued_at = NULL` |
| `draft` | `failed` | API | `HeadObject` diverge após a conclusão; objeto removido e `failure_code = SIZE_MISMATCH` |
| `draft` | registro removido | Varredura | `upload_expires_at` vencido |
| `processing` | `ready` | Worker | `UPDATE ... WHERE status = 'processing'` com duração, metadados e thumbnail |
| `processing` | `failed` | Worker | Erro permanente ou mensagem na DLQ |
| `failed` | `processing` | Operação manual | Dentro dos 7 dias; não há endpoint nesta fase |

### API Contracts

Todas as rotas exigem `Authorization: Bearer <access_token>` e usam o envelope de erro de `phase-02-auth/TD-07`. Os campos JSON seguem `camelCase`, alinhados ao contrato `{ url, expiresAt }` de `phase-03-videos/TD-13`.

#### POST /videos (SI-03.7)

**Request headers:**
- Authorization: Bearer token
- Content-Type: application/json

**Request body:**
- filename: string, required — 1 a 255 caracteres
- sizeBytes: integer, required — mínimo 1, máximo `VIDEO_MAX_UPLOAD_BYTES`

**Response 201:**
- id: string (uuid)
- slug: string
- status: `draft`
- partSizeBytes: number
- partCount: number
- uploadExpiresAt: string (ISO-8601)

**Error responses:**
- 400 validation error: quando o corpo é inválido
- 401 Unauthorized: sem token válido
- 404 CHANNEL_NOT_FOUND: quando o usuário autenticado não tem canal
- 409 ACTIVE_UPLOAD_LIMIT_REACHED: quando o canal já tem 3 uploads ativos
- 413 VIDEO_TOO_LARGE: quando `sizeBytes` excede `VIDEO_MAX_UPLOAD_BYTES`
- 429 ThrottlerException: acima de 10 requisições por 60s

---

#### POST /videos/:id/upload/part-urls (SI-03.8)

**Request headers:**
- Authorization: Bearer token
- Content-Type: application/json

**Request body:**
- partNumbers: integer[], required — 1 a 50 itens únicos, cada um entre 1 e `partCount`

**Response 201:**
- parts: array de `{ partNumber: number, url: string, contentLength: number }`
- expiresAt: string (ISO-8601), 1 hora após a assinatura

**Error responses:**
- 400 validation error: quando o corpo é inválido
- 400 INVALID_PART_NUMBER: quando um número excede `partCount`
- 401 Unauthorized: sem token válido
- 404 VIDEO_NOT_FOUND: vídeo inexistente ou de outro canal
- 409 UPLOAD_NOT_ACTIVE: vídeo fora de `draft`
- 410 UPLOAD_EXPIRED: sessão vencida
- 429 ThrottlerException: acima de 60 requisições por 60s

---

#### GET /videos/:id/upload/parts (SI-03.8)

**Request headers:**
- Authorization: Bearer token

**Response 200:**
- partSizeBytes: number
- partCount: number
- uploadExpiresAt: string (ISO-8601)
- parts: array de `{ partNumber: number, sizeBytes: number, etag: string }`, com todas as páginas de `ListParts`

**Error responses:**
- 401 Unauthorized: sem token válido
- 404 VIDEO_NOT_FOUND: vídeo inexistente ou de outro canal
- 409 UPLOAD_NOT_ACTIVE: vídeo fora de `draft`
- 410 UPLOAD_EXPIRED: sessão vencida
- 429 ThrottlerException: acima de 30 requisições por 60s

---

#### POST /videos/:id/upload/complete (SI-03.9)

**Request headers:**
- Authorization: Bearer token
- Content-Type: application/json

**Request body:**
- parts: array de `{ partNumber: integer, etag: string }`, required — 1 a 640 itens

**Response 202:**
- id: string (uuid)
- slug: string
- status: `processing` ou `ready`

Uma nova tentativa é idempotente. `NoSuchUpload` seguido de `HeadObject` correto conclui a transição, e um vídeo já em `processing` ou `ready` retorna 202 (`phase-03-videos/TD-07`).

**Error responses:**
- 400 validation error: quando o corpo é inválido
- 401 Unauthorized: sem token válido
- 404 VIDEO_NOT_FOUND: vídeo inexistente ou de outro canal
- 409 UPLOAD_INCOMPLETE: partes reais divergem antes da conclusão; o rascunho continua retomável
- 409 UPLOAD_NOT_ACTIVE: vídeo em `failed`
- 410 UPLOAD_EXPIRED: sessão vencida
- 422 VIDEO_SIZE_MISMATCH: `HeadObject` diverge após a conclusão; objeto removido e vídeo em `failed`
- 429 ThrottlerException: acima de 10 requisições por 60s

---

#### GET /videos/:slug (SI-03.14)

**Request headers:**
- Authorization: Bearer token

**Response 200:**
- id: string (uuid)
- slug: string
- status: `draft` | `processing` | `ready` | `failed`
- originalFilename: string
- sizeBytes: number | null
- contentType: string | null
- durationSeconds: number | null
- width: number | null
- height: number | null
- container: string | null
- videoCodec: string | null
- audioCodec: string | null
- thumbnailUrl: string | null — URL pré-assinada de 1 hora, somente em `ready`
- failureCode: string | null
- createdAt: string (ISO-8601)
- updatedAt: string (ISO-8601)

**Error responses:**
- 401 Unauthorized: sem token válido
- 404 VIDEO_NOT_FOUND: slug inexistente ou de outro canal
- 429 ThrottlerException: acima de 120 requisições por 60s

---

#### GET /videos/:slug/playback (SI-03.14)

**Request headers:**
- Authorization: Bearer token

**Response 200:**
- url: string — assinada com `ResponseContentType` e `ResponseContentDisposition: inline`
- expiresAt: string (ISO-8601) — validade `min(7 dias, max(1h, 2 × duração))`

**Error responses:**
- 401 Unauthorized: sem token válido
- 404 VIDEO_NOT_FOUND: slug inexistente ou de outro canal
- 409 VIDEO_NOT_READY: vídeo fora de `ready`
- 429 ThrottlerException: acima de 30 requisições por 60s

---

#### GET /videos/:slug/download (SI-03.14)

**Request headers:**
- Authorization: Bearer token

**Response 200:**
- url: string — assinada com `ResponseContentType` e `ResponseContentDisposition: attachment` com nome sanitizado
- expiresAt: string (ISO-8601) — validade de 6 horas

**Error responses:**
- 401 Unauthorized: sem token válido
- 404 VIDEO_NOT_FOUND: slug inexistente ou de outro canal
- 409 VIDEO_NOT_READY: vídeo fora de `ready`
- 429 ThrottlerException: acima de 10 requisições por 60s

---

#### Validation Rules — vídeos

- `:id`: UUID, validado com `ParseUUIDPipe`
- `:slug`: exatamente 11 caracteres base62; formato inválido responde `404 VIDEO_NOT_FOUND`
- `filename`: string, não vazia, máximo 255 caracteres
- `sizeBytes`: inteiro positivo. O limite por env é regra de negócio no service e responde `413`
- `partNumbers`: array de inteiros positivos, 1 a 50 itens, sem repetição
- `parts`: array de objetos validados, 1 a 640 itens, com `partNumber` único e `etag` não vazio

### Authorization Matrix

Não há rota pública de vídeo nesta fase. O acesso de quem não é dono responde `404 VIDEO_NOT_FOUND`, para não revelar a existência do vídeo.

| Endpoint | Anonymous | Authenticated | Owner |
|----------|-----------|---------------|-------|
| POST /videos | ✗ | ✓ (no próprio canal) | ✓ |
| POST /videos/:id/upload/part-urls | ✗ | ✗ | ✓ |
| GET /videos/:id/upload/parts | ✗ | ✗ | ✓ |
| POST /videos/:id/upload/complete | ✗ | ✗ | ✓ |
| GET /videos/:slug | ✗ | ✗ | ✓ |
| GET /videos/:slug/playback | ✗ | ✗ | ✓ (somente `ready`) |
| GET /videos/:slug/download | ✗ | ✗ | ✓ (somente `ready`) |

### Error Catalog

Erros HTTP usam o envelope `{ statusCode, error, message }` de `phase-02-auth/TD-07`, por exceções de domínio em `nestjs-project/src/videos/video.exceptions.ts`.

| errorCode | HTTP | Trigger |
|-----------|------|---------|
| CHANNEL_NOT_FOUND | 404 | Usuário autenticado sem canal ao iniciar o upload |
| VIDEO_NOT_FOUND | 404 | Vídeo inexistente, slug inválido ou vídeo de outro canal |
| VIDEO_TOO_LARGE | 413 | `sizeBytes` acima de `VIDEO_MAX_UPLOAD_BYTES` |
| ACTIVE_UPLOAD_LIMIT_REACHED | 409 | Canal com 3 rascunhos com `upload_expires_at` futuro (`phase-03-videos/TD-17`) |
| INVALID_PART_NUMBER | 400 | Número de parte acima de `part_count` |
| UPLOAD_NOT_ACTIVE | 409 | Operação de upload em vídeo fora de `draft` |
| UPLOAD_EXPIRED | 410 | Operação de upload após `upload_expires_at` |
| UPLOAD_INCOMPLETE | 409 | `ListParts` diverge das partes ou do tamanho declarado (`phase-03-videos/TD-07`) |
| VIDEO_SIZE_MISMATCH | 422 | `HeadObject` diverge após `CompleteMultipartUpload` (`phase-03-videos/TD-07`) |
| VIDEO_NOT_READY | 409 | Playback ou download fora de `ready` (`phase-03-videos/TD-13`) |

**Valores de `failure_code` (coluna, sem resposta HTTP própria):**

| failure_code | Classe | `storage_purge_after` | Origem |
|--------------|--------|-----------------------|--------|
| SIZE_MISMATCH | Permanente | Remoção imediata, com `storage_purged_at` preenchido | `phase-03-videos/TD-07`, `phase-03-videos/TD-18` |
| UNSUPPORTED_FORMAT | Permanente | Agora | `phase-03-videos/TD-12`, `phase-03-videos/TD-15`, `phase-03-videos/TD-18` |
| PROCESSING_EXHAUSTED | Infraestrutura | Agora + 7 dias | `phase-03-videos/TD-15`, `phase-03-videos/TD-18` |

### Events/Messages

#### video.processing.requested

**Payload:**

```json
{ "videoId": "uuid" }
```

**Producer:** `VideoUploadsService` na conclusão do upload e `VideoReconcilerService` no reenvio (per `phase-03-videos/TD-14`)
**Consumer:** `VideoProcessingConsumer` no `video-worker`, com 1 job por réplica (per `phase-03-videos/TD-10`)
**Trigger:** após o commit de `draft → processing`, ou quando o reconciliador encontra `job_enqueued_at` nulo há mais de 1 minuto ou anterior a 2h30
**Delivery semantics:** at-least-once, em SQS Standard (per `phase-03-videos/TD-01`, `phase-03-videos/TD-15`)

**Parâmetros da fila (per `phase-03-videos/TD-15`):** `maxReceiveCount: 4`, retenção de 14 dias, `VisibilityTimeout` de 120s renovado a cada 40s, limite de 30 minutos por execução e backoff de 30s, 60s e 120s em erro transitório.

#### video.processing.dead-lettered

**Payload:**

```json
{ "videoId": "uuid" }
```

**Producer:** redrive da fila principal após `maxReceiveCount: 4` (per `phase-03-videos/TD-15`)
**Consumer:** `VideoDlqConsumer` no `video-worker` (per `phase-03-videos/TD-15`)
**Trigger:** mensagem esgotou as 4 execuções
**Delivery semantics:** at-least-once. O `UPDATE` para `failed` com `PROCESSING_EXHAUSTED` só afeta vídeos em `processing` (per `phase-03-videos/TD-15`, `phase-03-videos/TD-18`)

#### Jobs agendados no `video-worker`

| Job | Responsabilidade | Seleção | Origem |
|-----|------------------|---------|--------|
| `VideoReconcilerService` | Reenviar vídeos em `processing` sem job confirmado ou com mensagem perdida | `FOR UPDATE SKIP LOCKED` | `phase-03-videos/TD-14` |
| `VideoCleanupService` | Abortar multipart, remover `source` e apagar rascunhos expirados | `FOR UPDATE SKIP LOCKED` | `phase-03-videos/TD-08` |
| `VideoCleanupService` | Remover objetos de vídeos `failed` vencidos e preencher `storage_purged_at` | `FOR UPDATE SKIP LOCKED` | `phase-03-videos/TD-18` |

---

## Dependency Map

```
SI-03.1 (root)
└── SI-03.2 — Compose depende das variáveis
    └── SI-03.3 — ambiente de testes depende da infraestrutura
        └── SI-03.4 — entidade e migration usam o banco de testes

SI-03.1 + SI-03.3
├── SI-03.5 — StorageModule
└── SI-03.6 — QueueModule

SI-03.4 + SI-03.5 + SI-03.6
└── SI-03.7 — POST /videos
    └── SI-03.8 — assinatura e retomada
        └── SI-03.9 — conclusão do upload

SI-03.5 + SI-03.6
└── SI-03.10 — processo video-worker

SI-03.5 + SI-03.10
└── SI-03.11 — extração com FFmpeg

SI-03.9 + SI-03.11
└── SI-03.12 — processamento e consumidor
    ├── SI-03.13 — reconciliador e DLQ
    └── SI-03.14 — consulta, streaming e download (+ SI-03.5)

SI-03.10 + SI-03.13
└── SI-03.15 — limpeza e retenção

SI-03.7 + SI-03.8 + SI-03.9 + SI-03.14
├── SI-03.16 — e2e de guards e limites
└── SI-03.17 — OpenAPI

SI-03.15 + SI-03.16 + SI-03.17
└── SI-03.18 — CLAUDE.md, Definition of Done e smoke test
```

Ordem linearizada: SI-03.1 → SI-03.2 → SI-03.3 → SI-03.4 → SI-03.5, SI-03.6 (paralelas) → SI-03.7 → SI-03.8 → SI-03.9 → SI-03.10 → SI-03.11 → SI-03.12 → SI-03.13, SI-03.14 (paralelas) → SI-03.15, SI-03.16, SI-03.17 (paralelas) → SI-03.18

---

## Deliverables

- [ ] SI-03.1 — Infra: Instalar dependências e declarar a configuração
- [ ] SI-03.2 — Infra: Provisionar MinIO, ElasticMQ e video-worker no Compose
- [ ] SI-03.3 — Infra: Isolar o ambiente de testes em `streamtube_test`
- [ ] SI-03.4 — Criar a entidade Video e sua migration
- [ ] SI-03.5 — Implementar o StorageModule
- [ ] SI-03.6 — Implementar o QueueModule
- [ ] SI-03.7 — Endpoint POST /videos
- [ ] SI-03.8 — Endpoints de assinatura de partes e retomada
- [ ] SI-03.9 — Endpoint de conclusão do upload
- [ ] SI-03.10 — Infra: Criar o processo video-worker
- [ ] SI-03.11 — Implementar a extração com FFmpeg
- [ ] SI-03.12 — Implementar o processamento e o consumidor da fila
- [ ] SI-03.13 — Implementar o reconciliador e o consumidor da DLQ
- [ ] SI-03.14 — Endpoints de consulta, streaming e download
- [ ] SI-03.15 — Implementar a limpeza e a retenção do storage
- [ ] SI-03.16 — Proteger os limites e a ordem dos guards
- [ ] SI-03.17 — Documentar os endpoints no OpenAPI
- [ ] SI-03.18 — Atualizar os CLAUDE.md e fechar a Definition of Done

**Full test suites:**

- [ ] Backend tests pass (`docker compose exec nestjs-api npm test -- --runInBand`)
- [ ] E2E tests pass (`docker compose exec nestjs-api npm run test:e2e`)
- [ ] Type/compilation checks pass (`docker compose exec nestjs-api npx tsc --noEmit`)
- [ ] Lint passes (`docker compose exec nestjs-api npm run lint`)
- [ ] Project builds successfully (`docker compose exec nestjs-api npm run build`)

**Smoke test manual:**

- [ ] Espaço livre confirmado com `df -h`: ao menos 15 GiB no disco do Docker
- [ ] Vídeo real chega a `ready`, com thumbnail, Range/206 e download íntegro
- [ ] Upload de `10737418240` bytes concluído, com objeto removido após `UNSUPPORTED_FORMAT`

_Permissões IAM e integração com SQS real exigem uma conta AWS e não fazem parte deste smoke local (`phase-03-videos/TD-16`)._
