# phase-03-videos — Progress

**Status:** completed
**SIs:** 18/18 completed

### SI-03.1 — Infra: Instalar dependências e declarar a configuração
- **Status:** completed
- **Tests:** 23 passing (`src/config/env.validation.integration-spec.ts`); `npx tsc --noEmit` com código 0
- **Observations:**
  - O `.env` local, não versionado, recebeu as novas variáveis a partir do `.env.example`.
  - A carga real do `ConfigModule` falha com `S3_PUBLIC_ENDPOINT` vazio e passa com o `.env` atualizado.

### SI-03.2 — Infra: Provisionar MinIO, ElasticMQ e video-worker no Compose
- **Status:** completed
- **Tests:** no tests (Infra); critérios verificados nos containers e `npx tsc --noEmit` com código 0
- **Observations:**
  - `nestjs-api` e `video-worker` declaram a mesma tag `nestjs-project-nestjs-api`, para rodarem de fato na mesma imagem.
  - A configuração documentada do ElasticMQ 1.7.1 não tem atributo de retenção. A retenção de 14 dias do TD-15 precisa ser aplicada ao provisionar as filas reais do SQS.

### SI-03.3 — Infra: Isolar o ambiente de testes em `streamtube_test`
- **Status:** completed
- **Tests:** 10 passing (`src/test/test-infrastructure.integration-spec.ts`); suíte completa executada 2 vezes com 173 testes unitários e de integração e 52 e2e passando; `npx tsc --noEmit` com código 0
- **Observations:**
  - O `globalSetup` passa as entidades reais ao DataSource, porque o TypeORM só instala `uuid-ossp` ao conhecer colunas UUID geradas, e as migrations dependem dessa extensão.
  - `src/test/test-environment.ts` foi adicionado para concentrar os nomes dos recursos de teste e as guardas, usadas também por `cleanAllTables`.
  - O banco `streamtube` tinha 0 registros de usuários, canais e tokens, e manteve essas contagens e as 2 migrations após as execuções.

### SI-03.4 — Criar a entidade Video e sua migration
- **Status:** completed
- **Tests:** 10 passing (`video.entity.integration-spec.ts` e `migrations.integration-spec.ts`); suíte completa com 181 testes unitários e de integração e 52 e2e passando; `npx tsc --noEmit` com código 0
- **Observations:**
  - Lacuna de sequência do plano: `Channel.videos` exige o `Video` registrado no TypeORM antes da SI-03.7. Por decisão do usuário, `videos.module.ts` foi antecipado apenas com `TypeOrmModule.forFeature([Video])` e registrado no `AppModule`. A SI-03.7 completa o módulo.
  - O enum usa o nome padrão do TypeORM, `videos_status_enum`. Declarar `enumName` com esse mesmo valor gerava uma diferença falsa de schema.
  - `migration:generate --check` não encontra diferença entre as entidades e o banco de desenvolvimento, que está com as 3 migrations aplicadas.

### SI-03.5 — Implementar o StorageModule
- **Status:** completed
- **Tests:** 13 passing nas suítes de storage; `npx tsc --noEmit` com código 0
- **Observations:**
  - No MinIO, o preflight libera a origem, e o `ETag` é exposto pelo header `Access-Control-Expose-Headers` da resposta do `PUT`, que é onde o navegador o lê.
  - O script `storage:setup` exige `S3_CORS_ALLOWED_ORIGINS` somente em S3 real. Essa variável não consta do plano e deve ser definida na implantação da Fase 07.

### SI-03.6 — Implementar o QueueModule
- **Status:** completed
- **Tests:** 8 passing nas suítes de fila; `npx tsc --noEmit` com código 0
- **Observations:**
  - Payload inválido é exposto com `videoId: null`, para o consumidor descartar a mensagem sem processá-la.

### SI-03.7 — Endpoint POST /videos
- **Status:** completed
- **Tests:** 31 passing (unitários, integração e `test/videos-create.e2e-spec.ts`); `npx tsc --noEmit` com código 0
- **Observations:**
  - O teste de integração força a falha de persistência com `jest.spyOn` e comprova no MinIO real que o multipart foi abortado.
  - `ChannelsService` ganhou `findByUserId` e `lockByUserId`, mantendo as consultas de canal no módulo de canais.

### SI-03.8 — Endpoints de assinatura de partes e retomada
- **Status:** completed
- **Tests:** 34 passing (unitários, integração e `test/videos-upload-parts.e2e-spec.ts`); `npx tsc --noEmit` com código 0
- **Observations:**
  - Um rascunho cujo multipart já não existe responde `409 UPLOAD_NOT_ACTIVE` em `GET /videos/:id/upload/parts`, em vez de uma lista vazia que faria o cliente reenviar o arquivo.

### SI-03.9 — Endpoint de conclusão do upload
- **Status:** completed
- **Tests:** 54 passing (unitários, integração e `test/videos-upload-complete.e2e-spec.ts`); `npx tsc --noEmit` com código 0
- **Observations:**
  - O teste de integração força a falha de `enqueue` e comprova no banco real que o vídeo fica em `processing` com `job_enqueued_at` nulo.
  - Um rascunho sem multipart e sem objeto responde `409 UPLOAD_NOT_ACTIVE`, pois não há o que concluir.

### SI-03.10 — Infra: Criar o processo video-worker
- **Status:** completed
- **Tests:** 2 passing (`database.module.spec.ts` e `video-worker.module.spec.ts`); `npx tsc --noEmit` com código 0
- **Observations:**
  - Verificado no container: o worker sobe com `docker compose up -d`, não abre porta HTTP, aguarda o `npm install` quando falta `node_modules` e fecha a conexão com o banco ao receber `SIGTERM`.
  - O build da API com o worker em execução preserva `dist-worker`. A coexistência das duas aplicações em modo watch será confirmada no smoke test da SI-03.18, único momento autorizado para subir a API.
  - O serviço usa `init: true` para repassar sinais e recolher processos filhos encerrados do FFmpeg.

### SI-03.11 — Implementar a extração com FFmpeg
- **Status:** completed
- **Tests:** 79 passing nas suítes do worker (`media-allowlist`, `ffmpeg.service` unitário e de integração, `video-worker.module`); `npx tsc --noEmit` com código 0
- **Observations:**
  - Além de `-protocol_whitelist`, o FFmpeg usa `-format_whitelist` com os demuxers da matriz do TD-12. Só a lista de protocolos não bastaria, porque uma playlist HLS enviada como vídeo poderia fazer o worker acessar URLs HTTP internas.
  - Uma falha não reconhecida do FFmpeg é tratada como transitória, para um problema de infraestrutura não ser informado como arquivo inválido. Se persistir, a DLQ encerra o vídeo com `PROCESSING_EXHAUSTED`.
  - Um arquivo sem duração legível, como um WebM gravado por `MediaRecorder`, é classificado como `UNSUPPORTED_FORMAT`.

### SI-03.12 — Implementar o processamento e o consumidor da fila
- **Status:** completed
- **Tests:** 35 passing (unitários e de integração de `VideoProcessorService` e `VideoProcessingConsumer`, com ElasticMQ, MinIO e FFmpeg reais); `npx tsc --noEmit` com código 0
- **Observations:**
  - `StorageService` e `VideoProcessingQueueService` passaram a destruir seus clientes em `onApplicationShutdown`. Em `onModuleDestroy`, os clientes eram fechados antes de os consumidores terminarem o job em andamento.
  - No encerramento gracioso, o job é abortado e a mensagem volta à fila com visibilidade 0, para outra réplica assumir sem esperar o backoff. Essa entrega conta no `maxReceiveCount`.

### SI-03.13 — Implementar o reconciliador e o consumidor da DLQ
- **Status:** completed
- **Tests:** 14 passing (`video-reconciler.service.integration-spec.ts` e `video-dlq.consumer.integration-spec.ts`); suítes de worker, storage e fila com 149 testes passando; `npx tsc --noEmit` com código 0
- **Observations:**
  - O reconciliador usa uma transação por vídeo. Uma falha da fila preserva os reenvios já feitos, e o vídeo que falhou continua elegível na execução seguinte.

### SI-03.14 — Endpoints de consulta, streaming e download
- **Status:** completed
- **Tests:** 54 passing (`videos.service` unitário e de integração, `videos.module` e os 9 cenários de `test/videos-access.e2e-spec.ts`); `npx tsc --noEmit` com código 0
- **Observations:**
  - O download assina `Content-Disposition` no formato RFC 6266, com `filename` em ASCII e `filename*` em UTF-8, para preservar acentos sem permitir injeção de header.

### SI-03.15 — Implementar a limpeza e a retenção do storage
- **Status:** completed
- **Tests:** 15 passing (`video-cleanup.service` unitário e de integração, `video-worker.module`); `npx tsc --noEmit` com código 0
- **Observations:**
  - `waitForCompletion` confirmado nos tipos de `@nestjs/schedule` 6.1.3. A limpeza roda a cada 10 minutos, intervalo que o plano não fixa.
  - Um item que falha é excluído apenas da execução atual, para o lote continuar sem repetir o mesmo erro.

### SI-03.16 — Proteger os limites e a ordem dos guards
- **Status:** completed
- **Tests:** 20 passing (`test/videos-throttling.e2e-spec.ts`, com os guards reais) e 2 passing em `throttler-exception.filter.spec.ts`; `npx tsc --noEmit` com código 0
- **Observations:**
  - Por decisão do usuário após a conclusão da fase, o `429` passou a seguir o envelope de `phase-02-auth/TD-07`: `{ statusCode: 429, error: "TOO_MANY_REQUESTS", message }`. O `ThrottlerExceptionFilter` é registrado em `main.ts` e nos setups de e2e que validam o `429`.
  - Limites, trackers, guards e `ThrottlerModule.forRoot` não mudaram. Nas rotas de auth, a única diferença é o campo `error` no corpo do `429`.

### SI-03.17 — Documentar os endpoints no OpenAPI
- **Status:** completed
- **Tests:** 18 passing (`src/openapi-export.integration-spec.ts`); regenerar `openapi.json` sem mudar o código não produz diff; `npx tsc --noEmit` com código 0
- **Observations:**
  - `GET /videos/:id/upload/parts` também documenta `400`, porque o `ParseUUIDPipe` responde esse status para um `:id` malformado, embora o contrato da rota não o liste.
  - Problema anterior a esta fase, fora do escopo: `npm run openapi:export` roda com `ts-node`, sem o plugin do Swagger, e por isso os DTOs de entrada saem sem propriedades no `openapi.json`, inclusive `RegisterDto`. As regras do projeto proíbem contornar isso com `@ApiProperty` nesses DTOs.

### SI-03.18 — Atualizar os CLAUDE.md e fechar a Definition of Done
- **Status:** completed
- **Tests:** suíte unitária e de integração com 451 passing em 50 suítes; e2e com 113 passing em 8 suítes; `npx tsc --noEmit` com código 0; `npm run lint` com 0 erros e 23 avisos, todos em testes de auth anteriores a esta fase; `npm run build` com código 0
- **Observations:**
  - `test/jest-e2e.json` passou a usar `maxWorkers: 1`. Sem isso, `npm run test:e2e` rodava as 8 suítes em paralelo no mesmo banco e falhava com violações de FK.
  - Smoke com 18 GiB livres: um MP4 H.264/AAC de 40 MB gerado com FFmpeg, enviado em 3 partes, chegou a `ready`, com thumbnail, Range/206 e download com o mesmo SHA-256.
  - Smoke de 10 GiB: o arquivo esparso de `10737418240` bytes foi enviado em 640 partes em 66s, terminou em `failed` com `UNSUPPORTED_FORMAT`, e a varredura removeu o objeto e devolveu o espaço em disco.
  - API e worker funcionaram juntos em modo watch. A API foi encerrada ao final, e os usuários, vídeos e objetos do smoke foram removidos do ambiente de desenvolvimento.
  - A divergência do corpo do `429` em relação ao envelope, encontrada no smoke, foi corrigida depois da conclusão. Ver as Observations da SI-03.16.
  - Fase 07: aplicar a retenção de 14 dias ao provisionar o SQS real, porque o ElasticMQ não tem esse atributo documentado, e definir `S3_CORS_ALLOWED_ORIGINS` para o S3 real.
