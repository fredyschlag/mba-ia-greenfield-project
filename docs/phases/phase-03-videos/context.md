---
kind: phase
name: phase-03-videos
sources_mtime:
  docs/project-plan.md: "2026-11-22T16:12:35-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-22T21:39:28-03:00"
  docs/decisions/technical-decisions-openapi-docs-nestjs.md: "2026-11-22T16:12:35-03:00"
  docs/phases/phase-01-configuracao-base/context.md: "2026-11-22T16:12:35-03:00"
  docs/phases/phase-02-auth/context.md: "2026-11-22T16:12:35-03:00"
  docs/phases/phase-02-auth-frontend/context.md: "2026-11-22T16:12:35-03:00"
  .claude/skills/testing-guide-nestjs-project/SKILL.md: "2026-11-22T16:12:35-03:00"
  .claude/skills/testing-guide-nestjs-project/references/external-systems.md: "2026-11-22T16:12:35-03:00"
---

# phase-03-videos — Context

## Scope

**Phase name:** Upload e Processamento de Vídeos

**Capabilities** (literal, `docs/project-plan.md`):

- Serviço de armazenamento de arquivos (vídeos e thumbnails)
- Serviço de processamento em segundo plano (filas)
- Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance
- Pré-cadastro automático do vídeo como rascunho ao iniciar o upload
- Processamento automático do vídeo após upload (extração de duração e metadados)
- Geração automática de thumbnail a partir de um frame do vídeo
- URL única por vídeo, sem conflito com outros vídeos
- Reprodução via streaming (sem necessidade de download completo)
- Download do vídeo pelo usuário

**Out of scope:** _Not specified._ (em `docs/project-plan.md`). Definido pelo usuário: publicação e visibilidade pertencem à Fase 04; frontend adiado.

**Deliverables:** upload de até 10GB funcional, processamento automático do vídeo, streaming funcionando, URLs únicas geradas.

**Affected subprojects:**

- `nestjs-project` — API
- `nestjs-project` — worker de vídeo
- `nestjs-project/compose.yaml` — infraestrutura Docker Compose

**Deferred subprojects:** `next-frontend` (definido pelo usuário; não declarado em `docs/project-plan.md`)

**Sequencing notes:** Depende de: Fase 01, Fase 02

**Neighbors (for boundary detection only):**

- **Phase 02:** Cadastro, Login e Gerenciamento de Conta. Depende de: Fase 01
- **Phase 04:** Gerenciamento de Vídeos e Canal. Depende de: Fase 02, Fase 03

## Decisions Index

| Ref | Source | Scope | Topic | Status | Decision | Libraries |
|-----|--------|-------|-------|--------|----------|-----------|
| phase-03-videos/TD-01 | phase | Backend | Tecnologia da fila de processamento | decided | D (SQS Standard + ElasticMQ) | @aws-sdk/client-sqs@3.1175.0 |
| phase-03-videos/TD-02 | phase | Repo-wide | Obtenção da imagem local do MinIO | decided | A (Build local da tag oficial fixada) | — |
| phase-03-videos/TD-03 | phase | Backend | Organização de buckets e chaves | decided | A (Um bucket privado com prefixo por vídeo) | — |
| phase-03-videos/TD-04 | phase | Backend | Endpoints do storage e URLs pré-assinadas | decided | A (Dois endpoints explícitos) | @aws-sdk/client-s3@3.1175.0, @aws-sdk/s3-request-presigner@3.1175.0 |
| phase-03-videos/TD-05 | phase | Cross-layer | Protocolo de upload de até 10GB | decided | A (S3 Multipart com URLs pré-assinadas) | @aws-sdk/client-s3@3.1175.0, @aws-sdk/s3-request-presigner@3.1175.0 |
| phase-03-videos/TD-06 | phase | Backend | Pré-cadastro automático do rascunho | decided | A (Chamada única cria upload e rascunho) | — |
| phase-03-videos/TD-07 | phase | Backend | Validação do tamanho real ao concluir o upload | decided | A (ListParts + HeadObject) | @aws-sdk/client-s3@3.1175.0 |
| phase-03-videos/TD-08 | phase | Backend | Limpeza de uploads abandonados | decided | A (Varredura guiada pelo banco) | @nestjs/schedule@6.1.3 |
|     └─ Last revision: 2026-11-22 — Varredura remove `source` de rascunhos expirados antes de apagar o registro | | | | | | |
| phase-03-videos/TD-09 | phase | Backend | Geração da URL única do vídeo | decided | A (Slug base62 + UNIQUE) | — |
| phase-03-videos/TD-10 | phase | Backend | Execução do worker de vídeo | decided | A (video-worker no mesmo projeto) | — |
| phase-03-videos/TD-11 | phase | Backend | Extração de metadados e thumbnail sem cópia integral | decided | A (HTTP Range com URL interna) | — |
| phase-03-videos/TD-12 | phase | Backend | Formatos aceitos para reprodução | decided | A (Allowlist sem transcodificação) | — |
| phase-03-videos/TD-13 | phase | Cross-layer | Entrega de streaming com Range/206 e download | decided | A (URLs pré-assinadas em JSON) | @aws-sdk/s3-request-presigner@3.1175.0 |
|     └─ Last revision: 2026-11-22 — Validade de streaming limitada a `min(7 dias, max(1h, 2 × duração))` | | | | | | |
| phase-03-videos/TD-14 | phase | Backend | Modelo de status do vídeo | decided | A (Status do pipeline) | — |
| phase-03-videos/TD-15 | phase | Backend | Retentativas, idempotência e tratamento de falhas | decided | A (At-least-once idempotente) | — |
| phase-03-videos/TD-16 | phase | Backend | Estratégia de testes com a infraestrutura real | decided | A (Pirâmide com Compose real) | — |
| phase-03-videos/TD-17 | phase | Backend | Política de limites dos endpoints de vídeo | decided | A (@Throttle por usuário + limite de uploads ativos) | @nestjs/throttler@^6.5.0 |
| phase-03-videos/TD-18 | phase | Backend | Destino dos objetos de vídeos em `failed` | decided | D (Retenção por classe de falha) | — |

_Source files:_

- phase-03-videos — `docs/decisions/technical-decisions-phase-03-videos.md` (scope_type: phase, related_phases: [3])

## Capability Coverage

| Capability (from project-plan.md) | Covered by |
|-----------------------------------|------------|
| Serviço de armazenamento de arquivos (vídeos e thumbnails) | phase-03-videos/TD-02, phase-03-videos/TD-03, phase-03-videos/TD-04, phase-03-videos/TD-16, phase-03-videos/TD-18 |
| Serviço de processamento em segundo plano (filas) | phase-03-videos/TD-01, phase-03-videos/TD-10, phase-03-videos/TD-15, phase-03-videos/TD-16 |
| Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance | phase-03-videos/TD-04, phase-03-videos/TD-05, phase-03-videos/TD-07, phase-03-videos/TD-08, phase-03-videos/TD-16, phase-03-videos/TD-17 |
| Pré-cadastro automático do vídeo como rascunho ao iniciar o upload | phase-03-videos/TD-06, phase-03-videos/TD-08, phase-03-videos/TD-14, phase-03-videos/TD-16 |
| Processamento automático do vídeo após upload (extração de duração e metadados) | phase-03-videos/TD-10, phase-03-videos/TD-11, phase-03-videos/TD-14, phase-03-videos/TD-15, phase-03-videos/TD-16 |
| Geração automática de thumbnail a partir de um frame do vídeo | phase-03-videos/TD-10, phase-03-videos/TD-11, phase-03-videos/TD-14, phase-03-videos/TD-15, phase-03-videos/TD-16 |
| URL única por vídeo, sem conflito com outros vídeos | phase-03-videos/TD-09, phase-03-videos/TD-16 |
| Reprodução via streaming (sem necessidade de download completo) | phase-03-videos/TD-04, phase-03-videos/TD-12, phase-03-videos/TD-13, phase-03-videos/TD-16 |
| Download do vídeo pelo usuário | phase-03-videos/TD-04, phase-03-videos/TD-13, phase-03-videos/TD-16 |

## Decisions Detail

### phase-03-videos/TD-01

**Recommendation:** com produção na AWS, o serviço gerenciado remove a operação da fila e a carga de polling do PostgreSQL. O custo aceito é manter um reconciliador simples para a escrita dupla. FIFO não é necessário, porque a ordem entre vídeos não importa e o worker já é idempotente (TD-15). Usar `@aws-sdk/client-sqs` diretamente, com um loop de consumo próprio, porque o `sqs-consumer` 15 é ESM-only. Chaves de ambiente: `SQS_ENDPOINT` (somente local, com o nome do serviço Compose), `SQS_REGION`, `SQS_VIDEO_PROCESSING_QUEUE_URL` e `SQS_VIDEO_PROCESSING_DLQ_URL`. No Compose, habilitar `messages-storage` do ElasticMQ com H2 em `/data` e volume nomeado, para um restart do container não perder jobs. Filas persistidas têm precedência sobre o arquivo de configuração, então mudanças nas definições exigem recriar esse volume.
**Libraries:** @aws-sdk/client-sqs@3.1175.0

### phase-03-videos/TD-02

**Recommendation:** para um storage usado apenas em desenvolvimento e testes, reprodutibilidade e ausência de terceiros pesam mais que o tempo do primeiro build. O risco dos CVEs é contido ao não expor a porta fora da máquina. Esta imagem é exclusiva do ambiente local, pois a produção usará Amazon S3.
**Libraries:** —

### phase-03-videos/TD-03

**Recommendation:** atende aos dois tipos de arquivo com a menor configuração e sustenta a idempotência do worker. O nome original nunca entra na chave.
**Libraries:** —

### phase-03-videos/TD-04

**Recommendation:** é a solução mais simples e previsível. **Exceção documentada:** `S3_PUBLIC_ENDPOINT` é o único valor que pode usar `localhost`, porque é consumido pelo navegador no host e nunca é aberto por um container. Ele deve ser obrigatório no Joi, sem default. Os clientes usam `forcePathStyle: true`, e o cliente de presign usa `requestChecksumCalculation: 'WHEN_REQUIRED'` para não incluir checksum automático em URLs de `UploadPart`.
**Libraries:** @aws-sdk/client-s3@3.1175.0, @aws-sdk/s3-request-presigner@3.1175.0

### phase-03-videos/TD-05

**Recommendation:** é a única opção que mantém a API fora do caminho dos dados sem adicionar serviço. Parâmetros propostos:

- Limite de 10 GiB (`10737418240` bytes), para não rejeitar arquivos que o sistema operacional exibe como 10 GB.
- Partes de 16 MiB, ou no máximo 640 partes, dentro dos limites de 5 MiB e 10.000 partes.
- URLs em lotes com validade de 1 hora e `Content-Length` assinado por parte, para limitar os bytes aceitos.
- **CORS local:** `MINIO_API_CORS_ALLOW_ORIGIN=http://localhost:3001`. O MinIO expõe `ETag` nesse handler global, e `PutBucketCors` é uma chamada sem efeito nele.
- **CORS em S3 real:** `PutBucketCors` com `ExposeHeaders: ['ETag']`.

**Libraries:** @aws-sdk/client-s3@3.1175.0, @aws-sdk/s3-request-presigner@3.1175.0

### phase-03-videos/TD-06

**Recommendation:** o pré-cadastro é consequência automática de iniciar o upload. Se a persistência falhar depois de criar o multipart, a API aborta o upload. Uma queda nesse intervalo é coberta pela rede de segurança do TD-08.
**Libraries:** —

### phase-03-videos/TD-07

**Recommendation:** é a única opção com comportamento igual nos dois storages. Divergência antes da conclusão mantém o rascunho retomável. Divergência depois da conclusão remove o objeto e marca o vídeo como `failed`.
**Libraries:** @aws-sdk/client-s3@3.1175.0

### phase-03-videos/TD-08

**Recommendation:** com sessão de 48h. Essa janela cobre 10 GiB em conexão de cerca de 1 Mbps (aproximadamente 24h). Como rede de segurança para órfãos, usar `MINIO_API_STALE_UPLOADS_EXPIRY=72h` localmente e lifecycle equivalente em S3 real, sempre acima da validade da sessão. Como o SQS não agenda execuções, a varredura roda no `video-worker` com `@nestjs/schedule` 6.1.3, a linha CommonJS compatível com NestJS 11. A seleção usa `FOR UPDATE SKIP LOCKED`, para réplicas não processarem o mesmo rascunho.
**Libraries:** @nestjs/schedule@6.1.3

**Revisions:**
- 2026-11-22 — Varredura remove `source` de rascunhos expirados antes de apagar o registro. Rationale: após `CompleteMultipartUpload` sem nova tentativa do cliente, o objeto ficaria órfão. A varredura chama `AbortMultipartUpload` e `DeleteObject` em `videos/{videoId}/source`, tolerando ausência.

### phase-03-videos/TD-09

**Recommendation:** mantém a URL curta e adequada a links não listados sem adicionar dependência. Mesmo com 1 bilhão de vídeos, a chance de um novo slug colidir é de cerca de 2 × 10⁻¹¹, e a restrição do banco cobre esse caso. O `slug` é o identificador das rotas de acesso ao vídeo: `GET /videos/:slug`, `GET /videos/:slug/playback` e `GET /videos/:slug/download`. O UUID continua sendo a referência interna em chaves de storage, mensagens da fila e na orquestração do upload. Quando a inserção ocorrer dentro de uma transação, como no TD-17, cada tentativa usa `SAVEPOINT`, porque uma violação `23505` aborta a transação no PostgreSQL.
**Libraries:** —

### phase-03-videos/TD-10

**Recommendation:** cumpre o diagrama sem duplicar o domínio. Usar concorrência inicial de 1 job por réplica, e não adotar `fluent-ffmpeg`, que está marcado como descontinuado no npm. No desenvolvimento, `nestjs-api` e `video-worker` usam o mesmo `Dockerfile.dev` com FFmpeg, mantendo `docker compose exec nestjs-api npm test -- --runInBand` como comando único da suíte. A separação de imagens de produção fica para a Fase 07.
**Libraries:** —

### phase-03-videos/TD-11

**Recommendation:** é a opção que atende ao requisito sem perder compatibilidade com MP4. Usar `-protocol_whitelist` restrito, para um arquivo malicioso não acionar outros protocolos, além de timeout e redação da URL nos logs. A imagem Debian bookworm instala FFmpeg 5.1.9, portanto usar apenas opções existentes nessa versão (`reconnect_max_retries`, por exemplo, não existe nela). Thumbnail proposta: frame em 10% da duração, com fallback para o primeiro frame.
**Libraries:** —

### phase-03-videos/TD-12

**Recommendation:** respeita o escopo da fase e mantém o status confiável. A perda é real: parte dos arquivos comuns será recusada até uma fase futura decidir por transcodificação.
**Libraries:** —

### phase-03-videos/TD-13

**Recommendation:** aproveita o Range nativo do storage e funciona com o BFF já decidido. Assinar `ResponseContentType` com o tipo validado pelo ffprobe e `ResponseContentDisposition` (`inline` no streaming, `attachment` com nome sanitizado no download). Validade proposta: `max(1h, 2 × duração)` para streaming e 6h para download. As rotas só assinam URLs para vídeos em `ready`. Nos demais status, respondem `409` com o código `VIDEO_NOT_READY`, no envelope de `phase-02-auth/TD-07`. As regras de acesso público ficam para as Fases 04 e 05.
**Libraries:** @aws-sdk/s3-request-presigner@3.1175.0

**Revisions:**
- 2026-11-22 — Validade de streaming limitada a `min(7 dias, max(1h, 2 × duração))`. Rationale: URLs SigV4 aceitam no máximo 604.800 segundos, e o player renova a URL quando ela expira.

### phase-03-videos/TD-14

**Recommendation:** preserva o ciclo pedido e deixa a publicação para a Fase 04. Com TD-01 Option D, a API faz commit de `draft → processing` com `job_enqueued_at` nulo, chama `SendMessage` e então preenche esse campo. Um reconciliador no `video-worker`, usando `FOR UPDATE SKIP LOCKED`, reenvia vídeos em `processing` em dois casos: `job_enqueued_at` nulo há mais de 1 minuto (falha entre o commit e o `SendMessage`) ou `job_enqueued_at` anterior a 2h30 (mensagem perdida). O segundo limite fica acima das 4 execuções previstas no TD-15, que somam cerca de 2h05, e cada reenvio atualiza `job_enqueued_at`. Com fila acumulada, o reenvio pode gerar duplicatas, que o TD-15 torna seguras. `processing → ready` grava duração, metadados e thumbnail em um único `UPDATE`.
**Libraries:** —

### phase-03-videos/TD-15

**Recommendation:** Valores iniciais com SQS:

- `maxReceiveCount: 4` (uma execução e até 3 retentativas), com retenção de 14 dias nas filas principal e DLQ.
- `VisibilityTimeout` de 120s, renovado a cada 40s por `ChangeMessageVisibility` enquanto o FFmpeg roda, com limite de 30 minutos por execução imposto pelo worker.
- Em erro transitório, ajustar a visibilidade para 30s, 60s e 120s, criando o backoff. Em erro permanente, marcar `failed` e chamar `DeleteMessage`.
- Um consumidor da DLQ marca o vídeo como `failed` com o código `PROCESSING_EXHAUSTED`.
- O handler confere o status ao iniciar e apaga a mensagem sem processar quando o vídeo não está mais em `processing`.
- A escrita final usa `WHERE status = 'processing'`, então duplicatas não alteram um vídeo já concluído.

**Libraries:** —

### phase-03-videos/TD-16

**Recommendation:** com estas regras:

- Bucket `streamtube-test` e filas de teste dedicadas no ElasticMQ, limpas com `PurgeQueue`, com `--runInBand`.
- Banco `streamtube_test` dedicado para toda a suíte, para a limpeza e o reconciliador do `video-worker` não atuarem sobre dados de teste, nem o teste de migrations remover tabelas em uso. A aplicação lê `DB_NAME` e `createTestDataSource` lê `DB_DATABASE`, então as duas variáveis devem apontar para esse banco. A criação precisa ser idempotente, porque scripts de inicialização do PostgreSQL não rodam em um volume já existente.
- Permissões IAM e a integração com SQS real ficam para um smoke test na AWS, pois o ElasticMQ não autentica requisições.
- Fixtures pequenas geradas por FFmpeg, incluindo MP4 com `moov` no final, e um teste que confirme a leitura parcial.
- Teste do limite com valor reduzido por env, sem enviar 10GB na suíte. O upload real de 10GB fica como smoke test manual.
- Para testar URLs públicas dentro do container, conectar em `minio:9000` preservando `Host: localhost:9000` com `http.request`, pois `fetch` não permite definir esse header.
- Testes que dependem de FFmpeg rodam no `nestjs-api`, que usa a mesma imagem de desenvolvimento do `video-worker` (TD-10).

**Libraries:** —

### phase-03-videos/TD-17

**Recommendation:** é a única opção que protege as rotas de vídeo por usuário sem tocar nos limites de autenticação. Limites propostos, por usuário e por rota:

| Operação | Requisições por 60s |
|----------|--------------------:|
| Criação do upload (`POST /videos`) | 10 |
| Assinatura de lote, com até 50 partes | 60 |
| Retomada (`ListParts`) | 30 |
| Conclusão do upload | 10 |
| Consulta (`GET /videos/:slug`) | 120 |
| Playback (`GET /videos/:slug/playback`) | 30 |
| Download (`GET /videos/:slug/download`) | 10 |

- **Dimensionamento:** 640 partes exigem 13 lotes de 50. Três uploads simultâneos somam 39 chamadas, abaixo do limite de 60.
- **Ordem dos guards:** manter `JwtAuthGuard` antes de `ThrottlerGuard`, como já está registrado. O `getTracker` usa `req.user.sub`, sem fallback para IP. Em teste com os guards reais, chamadas sem token receberam `401` sem consumir o contador do usuário, e a ordem invertida resultou em `500`, o que deve ser protegido por teste e2e.
- **Autenticação:** não alterar `ThrottlerModule.forRoot`. Rotas `@Public()` continuam com 10 requisições por 60 segundos, rastreadas por IP.
- **Uploads ativos:** máximo de 3 por canal, contando `draft` com `upload_expires_at` futuro, o que limita a 30 GiB o volume em andamento. A API faz uma checagem antes de `CreateMultipartUpload`. Depois, em transação, bloqueia o canal com `FOR UPDATE`, reconta e insere o rascunho. Se o limite foi atingido, aborta o multipart e responde `409` com `ACTIVE_UPLOAD_LIMIT_REACHED`, no envelope de `phase-02-auth/TD-07`.
- **Limitações aceitas:** com várias réplicas da API, o limite efetivo do throttler em memória se multiplica, e um storage compartilhado fica para a Fase 07. O limite de uploads ativos permanece exato por estar no banco. Esta política não cria cota total de armazenamento por canal, porque o plano não define esse requisito.

**Libraries:** @nestjs/throttler@^6.5.0

### phase-03-videos/TD-18

**Recommendation:** limita o custo sem transformar uma falha de infraestrutura em perda definitiva do upload.

- **Registro:** o vídeo permanece em `failed` com `failure_code`, `storage_purge_after` e `storage_purged_at`.
- **Prazo:** o mesmo `UPDATE` que marca `failed` define `storage_purge_after` como agora para erros permanentes e como agora + 7 dias para `PROCESSING_EXHAUSTED`. Cada vídeo retido ocupa no máximo 10 GiB por 7 dias.
- **Remoção:** o job agendado do TD-08 também seleciona vídeos vencidos com `FOR UPDATE SKIP LOCKED`, remove `videos/{videoId}/source` e `videos/{videoId}/thumbnail.jpg` e só então preenche `storage_purged_at`. Como `DeleteObject` é idempotente, uma queda é coberta pela execução seguinte.
- **TD-07:** a remoção por divergência de tamanho continua imediata e preenche `storage_purged_at`.
- **Acesso:** as rotas do TD-13 não assinam URLs para vídeos em `failed`.
- **Recuperação:** não há endpoint nesta fase. Dentro dos 7 dias, uma operação manual pode devolver o vídeo a `processing`, limpar os campos de falha e de purge e deixar `job_enqueued_at` nulo, para o reconciliador do TD-14 reenviar o job.

**Libraries:** —

## Inherited Decisions Detail

### phase-01-configuracao-base/TD-01

**Recommendation:** Option A (@nestjs/config) — Official, core-team-maintained, guaranteed NestJS 11 compatibility. The `registerAs()` factory pattern solves the TypeORM CLI sharing problem: the factory function can be imported as a plain function by `data-source.ts` while also serving as a DI injection token inside NestJS. Building a custom module recreates solved functionality; third-party packages carry maintenance risk.

**Libraries:** `@nestjs/config@^4.x`

### phase-01-configuracao-base/TD-02

**Recommendation:** Option A (Joi) — First-class integration with `@nestjs/config` via `validationSchema`, requiring zero custom wiring. Handles string-to-number coercion natively. Using a different tool for env validation vs. request validation is reasonable — env config is validated once at startup, DTOs are validated per-request. Zod is elegant but adds a third validation paradigm to the project.

**Libraries:** `joi@^17.x`

### phase-01-configuracao-base/TD-03

**Recommendation:** Option B (Namespaced/grouped with registerAs) — The project roadmap explicitly calls for auth, email, and storage in upcoming phases. Namespaced configs provide clear file boundaries per domain, typed injection via `ConfigType<typeof databaseConfig>`, and natural scalability. The `registerAs()` factory is dual-purpose: DI token inside NestJS and plain importable function for `data-source.ts`. Initial files for Phase 01: `src/config/database.config.ts`, `src/config/app.config.ts`.

**Libraries:** —

### phase-01-configuracao-base/TD-04

**Recommendation:** Option A (Shared registerAs factory) — Natural outcome of choosing `@nestjs/config` with `registerAs`. The factory is already callable by design. `data-source.ts` imports it, calls `dotenv.config()`, then calls the factory. Zero duplication, minimal code, no extra abstraction.

**Libraries:** `dotenv` (transitive via `@nestjs/config`)

### phase-02-auth/TD-01

**Recommendation:** Argon2id — For a greenfield project in 2026, Argon2id is the OWASP-recommended choice. The native build dependency is a one-time Docker setup cost. The project has no legacy constraints favoring bcrypt. OWASP minimum: 19MiB memory, 2 iterations.

**Libraries:** `argon2@^0.41.x`

### phase-02-auth/TD-02

**Recommendation:** Option A (@nestjs/passport) — The project plan includes only email/password auth for now, but the plugin architecture costs little and future phases may add social login. Aligns with official NestJS docs, making onboarding and maintenance easier.

**Note:** Decision deliberately diverged from the Recommendation during implementation — custom guards were preferred over `@nestjs/passport` to keep the dependency surface smaller; social login is not on the near-term roadmap, so the plugin-architecture benefit did not justify the extra abstraction layer.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-03

**Recommendation:** Option A (Refresh Token Rotation) — Provides the strongest security model with automatic theft detection. The DB write overhead is acceptable for a video platform (auth refresh is infrequent vs. video operations). PostgreSQL is already in the stack, so no new infrastructure needed. Race conditions can be mitigated with a short grace period for the old token.

**Libraries:** —

### phase-02-auth/TD-04

**Recommendation:** Option B (Random Opaque Tokens in DB) — Revocability is important: when a user requests a new password reset, previous tokens should be invalidated. The DB table is trivial to implement, and the tokens table can also serve future needs (e.g., API keys). Keeps email tokens decoupled from the JWT auth system.

**Libraries:** —

### phase-02-auth/TD-05

**Recommendation:** Option A (@nestjs-modules/mailer) — Best NestJS integration with minimal boilerplate. Supports SMTP (matching the architecture diagram), works with MailHog/Mailpit for local development without external dependencies, and scales to any SMTP provider in production. Template engine support (Handlebars) simplifies email formatting. No vendor lock-in.

**Libraries:** `@nestjs-modules/mailer@^2.x`, `handlebars@^4.x`

### phase-02-auth/TD-06

**Recommendation:** Option A (class-validator + class-transformer) — This is a backend-only project (no shared schemas with frontend), so Zod's single-source-of-truth advantage is less impactful. class-validator is the documented NestJS approach, and the project already uses decorators extensively (TypeORM entities, NestJS DI). Fewer integration surprises with NestJS 11.

**Libraries:** `class-validator@^0.14.x`, `class-transformer@^0.5.x`

### phase-02-auth/TD-07

**Recommendation:** Option A (Custom Domain Exception Filter) — Provides machine-readable error codes that the Next.js frontend can switch on, without the overhead of RFC 9457's URI-based type system. The project is single-consumer (first-party frontend), so a simple `{ statusCode, error, message }` format with domain codes balances clarity and simplicity. The custom filter cost is low — two small files.

**Libraries:** —

### phase-02-auth/TD-08

**Recommendation:** Option A (@nestjs/throttler) — Native NestJS integration is decisive: the guard system allows scoping rate limiting to `AuthModule` only via module-level `APP_GUARD`, with `@SkipThrottle()` for exemptions. The project is single-instance with no distributed requirements, so in-memory storage is sufficient. Using express-rate-limit would bypass NestJS's DI and guard lifecycle for no clear benefit.

**Libraries:** `@nestjs/throttler@^6.x`

### phase-02-auth/TD-09

**Recommendation:** Option B (Opaque) — Since DB lookup is mandatory (TD-03), JWT signature adds no security value. Opaque tokens are shorter, leak no data, and are simpler to generate.

**Note:** Decision deliberately diverged from the Recommendation — JWT was kept to reuse the access-token signing/verification infrastructure (`@nestjs/jwt`), trading token size and base64-readability for a single token format across the codebase.

**Libraries:** `@nestjs/jwt@^11.0.0`

### phase-02-auth/TD-10

**Recommendation:** Option A — The platform is a video sharing service with URL-based channel handles. A strict `[a-z0-9_]` allowlist is the simplest and most portable choice: no extra dependencies, no edge cases around hyphen positioning, and the `user_<random>` fallback provides a valid handle even for extreme email prefixes. Hyphens can always be added in a future iteration if user feedback justifies it.

**Libraries:** —

### phase-02-auth-frontend/TD-01

**Recommendation:** Three reasons. (1) **Architectural fit.** The strict-BFF model in `next-frontend-config-base/TD-03` already nominates the Route Handler as the only NestJS caller; cookie-based sessions are the natural match, and Auth.js's framework adds layers between the BFF and the cookie that buy nothing because the backend is the auth authority — Auth.js's value (DB adapters, OAuth providers, magic-link, `getServerSession` helpers) is mostly unused in this configuration. (2) **Smaller blast radius.** A ~50-LOC session helper is grep-friendly, debuggable, and test-friendly via the existing MSW+BFF integration test pattern; a misconfigured Auth.js callback is a longer fault-isolation loop. (3) **Compatibility with Next.js 16 / React 19.** Built-in `next/headers` `cookies()` is the canonical primitive both runtimes already use; Auth.js v5 versions track Next.js majors with a lag, adding compatibility risk that Option A does not have. Option C is rejected as unsafe (`localStorage` for refresh tokens) and architecturally regressive (loses RSC personalization).
**Libraries:** —

### phase-02-auth-frontend/TD-02

**Recommendation:** Three reasons. (1) **Defense in depth on the cookie content** — `httpOnly` blocks JS, encryption blocks accidental log/proxy inspection; the marginal cost is one ~3KB dep. (2) **Single cookie to manage** simplifies logout (one `session.destroy()` call) and avoids the orphan-cookie failure mode of Option A. (3) **Room to carry minimal user metadata** (`userId`, `email`, `channelSlug`) lets `app/layout.tsx` RSC render the authenticated chrome (avatar, channel name) without a per-render `/auth/me` round-trip — Phase 04+ gains compound here. Option A is a viable downgrade if the team rejects `iron-session` for any reason; the migration A→B (or B→A) is a one-Route-Handler refactor with no test changes downstream because the BFF interface is unchanged. Option C is rejected: it solves a problem (server-side revocation) the project does not have at the cost of infrastructure the project does not own.
**Libraries:** iron-session

### phase-02-auth-frontend/TD-03

**Recommendation:** The single-flight detail is non-trivial and goes in the helper from day one — tested by MSW with a "two concurrent intercepted upstream calls; one refresh expected" assertion. Option B's client-driven pattern is rejected because it doesn't replace Option A (RSC still needs server-side refresh) — adopting B means doing both. Option C's pre-emptive timer is rejected because the failure modes (multiple tabs, sleep/wake) outweigh the latency saving and force a `"use client"` shell near the root.
**Libraries:** —

### phase-02-auth-frontend/TD-04

**Recommendation:** Three reasons. (1) **Decoupled from TD-05** — works with Route Handlers OR Server Actions; the form code does not change if TD-05 is revisited later. (2) **Aligned with shadcn's canonical form primitive** — the project already commits to `radix-nova` shadcn (`components.json`); `npx shadcn@latest add form` produces react-hook-form wrappers; choosing react-hook-form means using the supported primitive instead of hand-rolling around it. (3) **Zod-first developer ergonomics match the rest of the FE foundation** — `next-frontend-config-base/TD-01` chose Zod 4 for env; the same schemas-as-source-of-truth pattern carries to forms with zero new validator paradigm. Option B is rejected for impedance with shadcn's primitive and for over-investing in progressive-enhancement that the strict-BFF model does not require. Option C is rejected for the per-field boilerplate and the loss of client-side feedback on a project that values quick, type-safe form iteration.
**Libraries:** react-hook-form, @hookform/resolvers

### phase-02-auth-frontend/TD-05

**Recommendation:** Three reasons. (1) **Strict-BFF alignment.** `next-frontend-config-base/TD-03` named Route Handlers as the BFF surface; Option A keeps every mutation visible under `app/api/**`. (2) **Test scaffold already exists** — `next-frontend/CLAUDE.md` § Testing and `next-frontend-msw-foundation` were authored for Route-Handlers-as-functions; Option A reuses them with zero invention. (3) **Single mutation surface** — Phase 02 sets the precedent for Phases 03–07; uniformity beats per-mutation idiom-picking when the cost of inconsistency compounds (Option C). Option B has real ergonomic appeal for the simplest forms but fragments the BFF surface and forces test-pattern reinvention; if the team later wants progressive enhancement for specific forms, the migration A→B is per-form and doesn't require touching unrelated routes — A is the safer default and the cheaper baseline.
**Libraries:** —

### phase-02-auth-frontend/TD-06

**Recommendation:** Two reinforcing reasons. (1) **No first-render flicker, no round-trip** — the session is delivered in the same response as the page HTML; the Client Provider hydrates with the correct initial state; users never see "Login" briefly turn into their avatar. (2) **No new BFF endpoint** — the cookie is the source of truth, RSC reads it, the Provider broadcasts it; the BFF surface stays minimal. The `router.refresh()` requirement after mid-session mutations is a small price (one line in the relevant mutation handler) for the structural benefits. Option B is rejected for the double-read-and-flicker; Option C is dominated by Option B and rejected.
**Libraries:** —

### phase-02-auth-frontend/TD-07

**Recommendation:** Three reasons. (1) **First-paint-correct** — the user sees the right outcome on the first paint, no skeleton, no flicker. (2) **Single integration pattern across both flows** — confirmation is RSC-only; reset is RSC + Client form (TD-04, TD-05 patterns reused) — both share the "RSC owns the token, Client Component owns the input" split. (3) **Email-prefetch behavior** is solved at the backend's idempotent-confirmation level (a small note for `/plan-build` to confirm; not a separate TD). Option B's Route-Handler-as-link-target adds redirects for no clean gain. Option C is dominated.
**Libraries:** —

### openapi-docs-nestjs/TD-01

**Recommendation:** Option A (`@nestjs/swagger`) — é a única opção que preserva as decisões anteriores (`class-validator` em TD-06 de phase-02-auth) sem re-platform; o CLI plugin com `classValidatorShim: true` aproveita os decoradores `class-validator` existentes para inferir schemas, mantendo o boilerplate baixo. Nestia tem mérito técnico real mas o custo de migração do stack de validação inviabiliza-a sem uma decisão upstream de supersede de TD-06. Manual authoring é descartado.

**Libraries:** @nestjs/swagger

**Revisions:**

- 2026-05-12 — Esclarece que o CLI plugin (`classValidatorShim: true`) cobre apenas inferência de schemas de DTOs a partir de `class-validator`; documentação de operações, respostas tipadas por status code, contratos de erro (alinhados ao envelope de phase-02-auth/TD-07) e exemplos exigem decoradores explícitos (`@ApiOperation`, `@ApiResponse`, `@ApiBody`, `@ApiParam`, `@ApiQuery`, `@ApiExtraModels`). _Rationale:_ openapi.json gerado pelo bootstrap atual está genérico — sem detalhes de parâmetros, schemas de retorno por status, nem contratos de erro — porque a base instalada se apoiou só na introspecção automática. Esta revisão fixa que enriquecimento via decoradores explícitos faz parte da Option A escolhida, não é trabalho fora do escopo do TD.

### openapi-docs-nestjs/TD-02

**Recommendation:** Option C (Ambos) — o custo marginal sobre Option A é apenas um npm script (~15 linhas) e o benefício é uma fundação correta para futura integração FE (codegen offline) sem perder a UI interativa que dev/QA usam. Option B sozinho pune a experiência de desenvolvimento em dev/local; Option A sozinho compromete o pipeline de codegen futuro. Combinar é dominante.

**Libraries:** —

### openapi-docs-nestjs/TD-03

**Recommendation:** Option B (Apenas em dev/staging) — alinha com a postura defensiva já estabelecida em phase 02 e não compromete consumidores legítimos (o `openapi.json` commitado em TD-02 cumpre o papel de "spec consultável fora da UI"). Re-abrir como Option A ou C é trivial no futuro se um caso de uso de API pública aparecer.

**Libraries:** —

## Inherited Conventions

- Backend config uses `@nestjs/config` with namespaced `registerAs(name, () => ({...}))` factories — one file per domain in `src/config/`. _(from phase 01)_
- Env variables are validated by a Joi schema in `src/config/env.validation.ts`, passed to `ConfigModule.forRoot({ validationSchema, validationOptions: { allowUnknown: true, abortEarly: false } })`. _(from phase 01)_
- Config is injected into modules via `ConfigType<typeof xxxConfig>` and `@Inject(xxxConfig.KEY)`; the same factory is importable as a plain function for non-DI contexts (e.g., TypeORM CLI). _(from phase 01)_
- `data-source.ts` loads `.env` via `import 'dotenv/config'` at the top, then imports `databaseConfig` and calls it as a plain function. _(from phase 01)_
- Database connection parameters (host, port, etc.) are sourced from a single `databaseConfig` factory — never duplicated between `AppModule` and `data-source.ts`. _(from phase 01)_
- `TypeOrmModule.forRootAsync` is used (not `forRoot`), with `imports: [ConfigModule]`, `inject: [databaseConfig.KEY]`, `useFactory` returning options including `autoLoadEntities: true`, `synchronize: false`. _(from phase 01)_

## Inherited Deferred Capabilities

| Capability | Status | Origin phase | Rationale |
|-----------|--------|--------------|-----------|
| Telas de frontend | deferred | phase-01-configuracao-base | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| Telas de cadastro, login, confirmação de conta e recuperação de senha | deferred | phase-02-auth | `next-frontend/` is not initialized in this phase; UI surfaces start in a later phase. |
| "Confirmação de conta via e-mail com link de ativação" | deferred | phase-02-auth-frontend | deferred_to_next_phase — UI landing screen de-scoped 2026-05-14; FE confirmation flow (TD-07) picked up by a future phase. BE side unchanged in `phase-02-auth`. |
| "Logout" | deferred | phase-02-auth-frontend | deferred_to_next_phase — logout button lives inside authenticated chrome (typically Phase 04). Phase 02 still implements POST `/api/auth/logout` (BFF route handler + `session.destroy()`) so the contract is ready when the chrome lands. |
| "Recuperação de senha (destination screen / set-new-password)" | deferred | phase-02-auth-frontend | deferred_to_next_phase — `/forgot-password` ships this phase sending the e-mail; the reset-password destination screen is absent from Figma → link destination remains a 404 until a later phase delivers the screen via `/screen-inventory` extension run. Documented as a known gap. |
| "Telas de cadastro, login, confirmação de conta e recuperação de senha" | deferred | phase-02-auth-frontend | a tela de confirmação da conta não será implementada nesta fase corrente, será adiada — the umbrella bullet's full coverage requires the confirmação and reset-password destination screens; both are deferred per Non-UI rows above. The 3 ship-this-phase telas (signup, login, forgot-password) are inventoried and covered by their own verbs; the umbrella bullet itself is deferred to the phase that lands the missing screens. |

## UI Inventory

_No screen inventory — UI↔API sync deferred. Run /screen-inventory phase-03-videos and then rerun /plan-context phase-03-videos to activate UI checks._

## Non-UI / Deferred Capabilities

_None._

## Testing Requirements

### nestjs-project

| Artifact type | Required layers |
|---------------|-----------------|
| Entity (`*.entity.ts`) | Integration: constraints, defaults, `select: false` |
| Service with branching + DB | Unit: branch logic (mock repo) + Integration: DB contract |
| Service with DB only (no branching) | Integration: DB contract |
| Service with configured lib (JWT, cache) | Unit: real lib with test config |
| Service with side-effect dep (email, storage) | Integration: real capture service (Mailpit) or local adapter |
| Module with configured imports | Unit: compilation test |
| Controller | E2E only — do NOT write unit tests |
| DTO | E2E: one validation wiring test per endpoint |
| Guard (delegates to service for business logic) | E2E + Unit if complex internal logic |
| Guard (simple, delegates to Passport) | E2E only |
| Strategy (Passport) | E2E via guard |
| Pipe (custom transformation/validation) | Unit |
| Interceptor (response transform, logging) | Unit and/or E2E |
| Exception Filter | Unit + E2E |
| Middleware | E2E |

> **IC-1 resolvido:** `phase-03-videos/TD-16` prevalece nesta fase, com testes na infraestrutura real do Compose. A atualização do guia `testing-guide-nestjs-project` é uma tarefa separada.

### next-frontend

_Deferred subproject — frontend out of scope for this phase; testing requirements apply when the video UI is planned._
