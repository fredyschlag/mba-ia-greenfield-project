# phase-03-videos — Progress

**Status:** in_progress
**SIs:** 4/18 completed

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
- **Status:** pending
- **Tests:** pendente
- **Observations:** none

### SI-03.6 — Implementar o QueueModule
- **Status:** pending
- **Tests:** pendente
- **Observations:** none

### SI-03.7 — Endpoint POST /videos
- **Status:** pending
- **Tests:** pendente
- **Observations:** none

### SI-03.8 — Endpoints de assinatura de partes e retomada
- **Status:** pending
- **Tests:** pendente
- **Observations:** none

### SI-03.9 — Endpoint de conclusão do upload
- **Status:** pending
- **Tests:** pendente
- **Observations:** none

### SI-03.10 — Infra: Criar o processo video-worker
- **Status:** pending
- **Tests:** pendente
- **Observations:** none

### SI-03.11 — Implementar a extração com FFmpeg
- **Status:** pending
- **Tests:** pendente
- **Observations:** none

### SI-03.12 — Implementar o processamento e o consumidor da fila
- **Status:** pending
- **Tests:** pendente
- **Observations:** none

### SI-03.13 — Implementar o reconciliador e o consumidor da DLQ
- **Status:** pending
- **Tests:** pendente
- **Observations:** none

### SI-03.14 — Endpoints de consulta, streaming e download
- **Status:** pending
- **Tests:** pendente
- **Observations:** none

### SI-03.15 — Implementar a limpeza e a retenção do storage
- **Status:** pending
- **Tests:** pendente
- **Observations:** none

### SI-03.16 — Proteger os limites e a ordem dos guards
- **Status:** pending
- **Tests:** pendente
- **Observations:** none

### SI-03.17 — Documentar os endpoints no OpenAPI
- **Status:** pending
- **Tests:** pendente
- **Observations:** none

### SI-03.18 — Atualizar os CLAUDE.md e fechar a Definition of Done
- **Status:** pending
- **Tests:** pendente
- **Observations:** none
