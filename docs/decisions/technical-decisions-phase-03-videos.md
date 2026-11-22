---
scope_type: phase
related_phases: [3]
status: pending
date: 2026-11-22
scope_description: "Backend da Fase 03: fila de processamento, uso do object storage S3/MinIO, upload de até 10GB, pré-cadastro do rascunho, worker FFmpeg, URL única, streaming, download, ciclo de status e estratégia de testes com a infraestrutura real do Compose."
---

# Technical Decisions — Fase 03: Upload e Processamento de Vídeos

_Subprojects in scope:_

- `nestjs-project/` — API, worker de vídeo e infraestrutura no `compose.yaml`. Todos os TDs deste documento incidem aqui.
- `next-frontend/` — Fora do escopo por definição desta pesquisa: nenhuma tela ou código de frontend é decidido aqui. TD-05 e TD-13 são `Cross-layer` apenas porque fixam o contrato HTTP que um frontend futuro consumirá.

> **Limite com a Fase 04:** publicação e visibilidade não são decididas aqui. Nesta fase, todo vídeo permanece privado ao dono do canal, mesmo quando o processamento termina.
>
> **Premissa de produção:** a produção será na AWS, conforme definido em 2026-11-22. O desenho da implantação continua pertencendo à Fase 07.

---

## TD-01: Tecnologia da fila de processamento

**Scope:** Backend

**Capability:** Serviço de processamento em segundo plano (filas)

**Context:** O diagrama de arquitetura mantém a fila como `TBD`. A carga esperada é de um job por upload concluído, com baixa vazão e execução relativamente longa. Com a produção na AWS, um serviço gerenciado elimina a operação de um broker. O requisito mais sensível é não deixar um vídeo em `processing` sem job, nem um job sem a mudança de status (TD-14).

**Options:**

### Option A: pg-boss 12 sobre o PostgreSQL existente

- Guarda os jobs em um schema próprio (`pgboss`) e aceita `send(..., { db })`, que insere o job na transação da aplicação. Oferece retentativas, backoff, expiração, heartbeat, dead letter e agendamento.
- **Pros:** Nenhum serviço novo no Compose. A mudança de status e o job são atômicos, sem outbox. O agendamento também atende à limpeza do TD-08.
- **Cons:** O pacote é ESM-only e o Jest atual falha ao carregá-lo sem uma allowlist em `transformIgnorePatterns`. Não há módulo oficial para NestJS nem adapter para TypeORM, então é preciso um provider e um `executeSql` próprios. Exige `pg ^8.23.1` (instalado: 8.20.0) e adiciona polling ao banco principal.

### Option B: BullMQ 6 com Redis

- Fila sobre Redis com integração oficial por `@nestjs/bullmq` (`@Processor`, `WorkerHost`). Publica build CommonJS.
- **Pros:** Melhor integração com NestJS, sem atrito de ESM no Jest. Alta vazão e ecossistema maduro. É o exemplo já citado no guia de testes do projeto.
- **Cons:** Adiciona um serviço com estado, que exige AOF e `maxmemory-policy=noeviction`. O enqueue fica fora da transação do PostgreSQL, o que exige outbox ou reconciliador para cobrir falhas entre as duas escritas.

### Option C: RabbitMQ

- Broker AMQP com filas duráveis, acknowledgements e dead-letter exchanges.
- **Pros:** Padrão consolidado para mensageria entre serviços, com roteamento flexível.
- **Cons:** Adiciona um serviço e mais conceitos operacionais. Backoff depende de TTL e DLX. Mantém o problema de escrita dupla. O roteamento avançado não atende a nenhuma necessidade da fase.

### Option D: Amazon SQS Standard, com ElasticMQ no ambiente local

- Fila gerenciada na AWS, acessada por `@aws-sdk/client-sqs`. No Compose, `softwaremill/elasticmq-native:1.7.1` expõe a API compatível em `http://elasticmq:9324`.
- **Pros:** Nenhum broker para operar em produção, escala independente do banco e DLQ nativa. Alinha a fila à produção na AWS. O SDK publica CommonJS, sem ajuste de ESM no Jest.
- **Cons:** Não participa da transação do PostgreSQL, exigindo um reconciliador (TD-14). Backoff e heartbeat dependem de `ChangeMessageVisibility`, e não há agendamento nativo (TD-08). A fila Standard pode entregar duplicatas, e o ElasticMQ não valida IAM.

**Recommendation:** **Option D (SQS Standard + ElasticMQ)** — com produção na AWS, o serviço gerenciado remove a operação da fila e a carga de polling do PostgreSQL. O custo aceito é manter um reconciliador simples para a escrita dupla. FIFO não é necessário, porque a ordem entre vídeos não importa e o worker já é idempotente (TD-15). Usar `@aws-sdk/client-sqs` diretamente, com um loop de consumo próprio, porque o `sqs-consumer` 15 é ESM-only. Chaves de ambiente: `SQS_ENDPOINT` (somente local, com o nome do serviço Compose), `SQS_REGION`, `SQS_VIDEO_PROCESSING_QUEUE_URL` e `SQS_VIDEO_PROCESSING_DLQ_URL`.

**Decision:** _[pending]_

---

## TD-02: Obtenção da imagem local do MinIO

**Scope:** Repo-wide

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** O uso de MinIO local já está definido e não é reaberto aqui. O problema é como obtê-lo: em 2026-11-22, `minio/minio` e `quay.io/minio/minio` não resolveram nos registries (imagens de controle resolveram), `dl.min.io` retornou `410 Gone` para o servidor e o `mc`, e o README oficial declara distribuição somente por código-fonte. O repositório está arquivado. Portanto, `image: minio/minio` não é uma configuração viável.

**Options:**

### Option A: Build local a partir da tag oficial fixada

- Um Dockerfile multi-stage compila `RELEASE.2025-10-15T17-29-55Z` (commit `9e49d5e7a648`) com Go 1.24.8, e o Compose usa `build`.
- **Pros:** Código oficial, versão reproduzível e nenhum publicador terceiro na cadeia. Buckets podem ser criados pela API S3, sem depender do `mc`.
- **Cons:** O primeiro build é mais lento. A versão está congelada e há CVEs reportados sem correção upstream (ex.: CVE-2026-39414 e CVE-2026-34204), então a porta deve ser publicada só em `127.0.0.1`.

### Option B: Imagem do fork `pgsty/minio`, fixada por digest

- Usa a imagem `RELEASE.2026-08-04T00-00-00Z`, mantida pela PGSTY (projeto agora chamado Silo), para amd64 e arm64.
- **Pros:** Pull imediato e correções de segurança mais recentes que a última versão oficial.
- **Cons:** Introduz um publicador terceiro na cadeia de suprimentos. O fork pode divergir do comportamento documentado do MinIO, e a compatibilidade precisaria ser validada.

### Option C: Imagem Chainguard, fixada por digest

- Usa `cgr.dev/chainguard/minio`, uma imagem mínima e endurecida para amd64 e arm64.
- **Pros:** Pull imediato e superfície de ataque reduzida.
- **Cons:** A versão efetiva fica implícita no digest, e a retenção de digests antigos não foi confirmada. Uma imagem mínima pode não ter shell para o healthcheck do Compose.

**Recommendation:** **Option A (build da tag oficial)** — para um storage usado apenas em desenvolvimento e testes, reprodutibilidade e ausência de terceiros pesam mais que o tempo do primeiro build. O risco dos CVEs é contido ao não expor a porta fora da máquina. Esta imagem é exclusiva do ambiente local, pois a produção usará Amazon S3.

**Decision:** _[pending]_

---

## TD-03: Organização de buckets e chaves

**Scope:** Backend

**Capability:** Serviço de armazenamento de arquivos (vídeos e thumbnails)

**Context:** API, worker, limpeza e testes precisam da mesma convenção de chaves. Ela afeta idempotência (TD-15), remoção de artefatos e crescimento do armazenamento.

**Options:**

### Option A: Um bucket privado com prefixo por vídeo

- Bucket `streamtube-media`, com `videos/{videoId}/source` e `videos/{videoId}/thumbnail.jpg`, usando o UUID interno.
- **Pros:** Menos configuração e provisionamento. Todos os artefatos de um vídeo ficam sob um prefixo. Chaves determinísticas tornam reprocessamentos idempotentes.
- **Cons:** Políticas diferentes para vídeos e thumbnails precisam usar filtros por prefixo.

### Option B: Dois buckets privados

- `streamtube-videos` para originais e `streamtube-thumbnails` para imagens, ambos com chave por `videoId`.
- **Pros:** Separação direta de políticas, CORS e classes de armazenamento.
- **Cons:** Mais variáveis e provisionamento, sem necessidade concreta nesta fase. No MinIO o CORS é global, então a separação não traz ganho local.

### Option C: Chave por canal e nome original

- Formato `{channelId}/{nomeOriginal}`.
- **Pros:** Legível ao navegar no bucket.
- **Cons:** Nomes colidem, carregam dados do usuário e exigem sanitização. Mudanças de dono ou nome afetariam a chave.

**Recommendation:** **Option A (um bucket com prefixo por `videoId`)** — atende aos dois tipos de arquivo com a menor configuração e sustenta a idempotência do worker. O nome original nunca entra na chave.

**Decision:** _[pending]_

---

## TD-04: Endpoints do storage e URLs pré-assinadas

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de armazenamento de arquivos (vídeos e thumbnails)", "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** A assinatura SigV4 inclui o host. Uma URL assinada para `minio:9000` não abre no navegador, e reescrever o host depois de assinar invalida a assinatura. O contrato aparece no Joi, no Compose, no `.env.example` e nos clientes S3.

**Options:**

### Option A: Dois endpoints explícitos

- `S3_ENDPOINT=http://minio:9000` é usado em toda conexão real de API e worker. `S3_PUBLIC_ENDPOINT=http://localhost:9000` é usado somente para assinar URLs entregues ao navegador.
- **Pros:** Contrato explícito, sem truques de rede, e mapeia diretamente para um domínio público em produção.
- **Cons:** Dois clientes S3 e uma exceção documentada à regra de Docker Networking.

### Option B: Um único hostname nos dois lados

- Um alias de rede como `minio.localhost` resolve para o container no Docker e para loopback no host.
- **Pros:** Uma única configuração de endpoint.
- **Cons:** Depende de como cada sistema e navegador resolve `*.localhost`, e esse arranjo não existe em produção.

### Option C: Gateway reverso na frente do storage

- Nginx ou BFF expõe o storage em uma origem pública e encaminha ao MinIO preservando o host assinado.
- **Pros:** Origem única pode simplificar CORS.
- **Cons:** Coloca outro componente no caminho de arquivos de até 10GB e adiciona configuração sem requisito que a justifique.

**Recommendation:** **Option A (dois endpoints)** — é a solução mais simples e previsível. **Exceção documentada:** `S3_PUBLIC_ENDPOINT` é o único valor que pode usar `localhost`, porque é consumido pelo navegador no host e nunca é aberto por um container. Ele deve ser obrigatório no Joi, sem default. Os clientes usam `forcePathStyle: true`, e o cliente de presign usa `requestChecksumCalculation: 'WHEN_REQUIRED'` para não incluir checksum automático em URLs de `UploadPart`.

**Decision:** _[pending]_

---

## TD-05: Protocolo de upload de até 10GB

**Scope:** Cross-layer

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** O arquivo não pode atravessar a API de forma bloqueante, e o plano exige retomada após falha de conexão. Um `PUT` único do S3 é limitado a 5 GiB, então não cobre o requisito. O protocolo define o contrato entre API, storage e o futuro frontend. Depende de TD-04.

**Options:**

### Option A: S3 Multipart com URLs pré-assinadas por parte

- A API cria o upload e assina lotes de partes. O navegador envia cada parte direto ao storage, a API consulta `ListParts` para retomar e conclui o upload.
- **Impacto:** a API só orquestra. O frontend futuro fatia o arquivo, controla concorrência e envia os ETags.
- **Pros:** Nenhum byte de vídeo passa pela API. Retomada nativa e nenhum serviço adicional.
- **Cons:** Mais lógica no cliente. O CORS precisa expor `ETag`, e cada URL de parte funciona como credencial temporária.

### Option B: tusd como serviço dedicado

- O cliente fala o protocolo tus com um container `tusd`, que grava no S3 e notifica a API por hooks.
- **Impacto:** a API integra hooks. O frontend futuro pode usar `tus-js-client` ou Uppy.
- **Pros:** Protocolo de retomada padronizado e cliente pronto.
- **Cons:** Novo serviço no caminho dos dados, com disco temporário para partes e objetos auxiliares no bucket.

### Option C: `@tus/server` embutido no NestJS

- O servidor tus roda dentro da API e repassa os dados ao S3.
- **Impacto:** o frontend futuro usa tus, com a API como destino do upload.
- **Pros:** Protocolo padronizado sem container adicional.
- **Cons:** Todo o tráfego de 10GB passa pelo processo da API, contrariando o requisito de não impactar a performance.

**Recommendation:** **Option A (S3 Multipart pré-assinado)** — é a única opção que mantém a API fora do caminho dos dados sem adicionar serviço. Parâmetros propostos:

- Limite de 10 GiB (`10737418240` bytes), para não rejeitar arquivos que o sistema operacional exibe como 10 GB.
- Partes de 16 MiB, ou no máximo 640 partes, dentro dos limites de 5 MiB e 10.000 partes.
- URLs em lotes com validade de 1 hora e `Content-Length` assinado por parte, para limitar os bytes aceitos.
- **CORS local:** `MINIO_API_CORS_ALLOW_ORIGIN=http://localhost:3001`. O MinIO expõe `ETag` nesse handler global, e `PutBucketCors` é uma chamada sem efeito nele.
- **CORS em S3 real:** `PutBucketCors` com `ExposeHeaders: ['ETag']`.

**Decision:** _[pending]_

---

## TD-06: Pré-cadastro automático do rascunho

**Scope:** Backend

**Capability:** Pré-cadastro automático do vídeo como rascunho ao iniciar o upload

**Context:** O vídeo precisa existir assim que o upload começa, com identificador e URL própria. A escolha define o endpoint inicial e como lidar com falhas entre o banco e o storage. Depende de TD-05 e TD-09.

**Options:**

### Option A: Uma chamada inicia upload e cria o rascunho

- `POST /videos` recebe nome, tamanho e tipo, cria o multipart e persiste o vídeo `draft` com título inicial derivado do nome do arquivo. Retorna `id`, `slug`, `status` e os dados do upload.
- **Pros:** Atende literalmente ao requisito e não permite rascunho sem sessão de upload. O `uploadId` fica somente no servidor.
- **Cons:** Coordena banco e storage na mesma operação, exigindo compensação se a segunda escrita falhar.

### Option B: Criar rascunho e iniciar upload em duas chamadas

- `POST /videos` cria o rascunho, e `POST /videos/:id/upload` abre o multipart.
- **Pros:** Separa recursos e facilita reabrir uma sessão futuramente.
- **Cons:** Permite rascunhos sem upload e adiciona uma chamada sem benefício na fase.

**Recommendation:** **Option A (chamada única)** — o pré-cadastro é consequência automática de iniciar o upload. Se a persistência falhar depois de criar o multipart, a API aborta o upload. Uma queda nesse intervalo é coberta pela rede de segurança do TD-08.

**Decision:** _[pending]_

---

## TD-07: Validação do tamanho real ao concluir o upload

**Scope:** Backend

**Capability:** Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance

**Context:** O tamanho declarado pelo cliente não é confiável. A validação precisa ocorrer no servidor, funcionar em MinIO e S3 e suportar uma nova tentativa quando a resposta de conclusão se perde. Depende de TD-05.

**Options:**

### Option A: `ListParts` antes e `HeadObject` depois de concluir

- A API soma as partes reais antes de `CompleteMultipartUpload` e confere o `ContentLength` final depois.
- **Pros:** Rejeita divergências antes de montar o objeto e confirma o resultado real. `NoSuchUpload` seguido de `HeadObject` correto torna a conclusão idempotente.
- **Cons:** Duas chamadas extras ao storage e paginação de `ListParts`.

### Option B: Apenas `HeadObject` depois de concluir

- A API conclui o upload e só então confere o tamanho final.
- **Pros:** Implementação menor.
- **Cons:** Um arquivo inválido é montado antes da rejeição, e o erro não pode mais ser corrigido retomando as partes.

### Option C: `MpuObjectSize` na conclusão

- Envia o tamanho esperado para o storage validar em `CompleteMultipartUpload`.
- **Pros:** Validação atômica no S3.
- **Cons:** O código da última versão do MinIO não referencia esse campo, então o ambiente local não reproduziria a proteção.

**Recommendation:** **Option A (`ListParts` + `HeadObject`)** — é a única opção com comportamento igual nos dois storages. Divergência antes da conclusão mantém o rascunho retomável. Divergência depois da conclusão remove o objeto e marca o vídeo como `failed`.

**Decision:** _[pending]_

---

## TD-08: Limpeza de uploads abandonados

**Scope:** Backend

**Capability:** Transversal — covers: "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload"

**Context:** Multiparts abandonados ocupam espaço e deixam rascunhos sem arquivo. O MinIO não suporta a ação de lifecycle `AbortIncompleteMultipartUpload`, e seu `ListMultipartUploads` exige o nome exato do objeto. Sua limpeza própria conta 24h desde a criação do upload, mesmo que ele continue ativo. Depende de TD-01 e TD-06.

**Options:**

### Option A: Varredura da aplicação guiada pelo banco

- Um job agendado busca rascunhos com `upload_expires_at` vencido, chama `AbortMultipartUpload` e remove o registro.
- **Pros:** Limpa storage e banco juntos, funciona igual em MinIO e S3 e não depende de listagem do storage.
- **Cons:** Exige job agendado, tratamento idempotente e testes.

### Option B: Lifecycle do storage

- Regra `AbortIncompleteMultipartUpload` no bucket.
- **Pros:** Sem código de aplicação em S3 real.
- **Cons:** Não funciona no MinIO e não remove os rascunhos.

### Option C: Expiração interna do MinIO

- Usa apenas `MINIO_API_STALE_UPLOADS_EXPIRY`.
- **Pros:** Nenhum código de aplicação.
- **Cons:** Não existe em S3, não remove rascunhos e pode matar um upload ativo se a janela for curta.

**Recommendation:** **Option A (varredura guiada pelo banco)**, com sessão de 48h. Essa janela cobre 10 GiB em conexão de cerca de 1 Mbps (aproximadamente 24h). Como rede de segurança para órfãos, usar `MINIO_API_STALE_UPLOADS_EXPIRY=72h` localmente e lifecycle equivalente em S3 real, sempre acima da validade da sessão. Como o SQS não agenda execuções, a varredura roda no `video-worker` com `@nestjs/schedule` 6.1.3, a linha CommonJS compatível com NestJS 11. A seleção usa `FOR UPDATE SKIP LOCKED`, para réplicas não processarem o mesmo rascunho.

**Decision:** _[pending]_

---

## TD-09: Geração da URL única do vídeo

**Scope:** Backend

**Capability:** URL única por vídeo, sem conflito com outros vídeos

**Context:** O plano pede uma URL curta que nunca conflite. Como a Fase 04 terá vídeos unlisted, acessíveis somente por link, o identificador também não pode ser enumerável. O container roda Node 25.6, e o `nanoid` 6 declara `^22 || ^24 || >=26`.

**Options:**

### Option A: Slug aleatório base62 com `node:crypto`

- Gera 11 caracteres com fonte criptográfica, persiste em coluna `UNIQUE` e tenta novamente em caso de violação.
- **Pros:** Curto, não enumerável e sem dependência. São cerca de 65 bits de entropia, e o banco garante a unicidade.
- **Cons:** Exige um gerador pequeno e o tratamento do erro `23505`.

### Option B: `nanoid`

- Usa `customAlphabet` com o mesmo tamanho e alfabeto.
- **Pros:** Biblioteca conhecida para IDs compactos.
- **Cons:** A versão atual não declara suporte ao Node 25 e é ESM-only. Adiciona dependência para algo que `node:crypto` resolve.

### Option C: Sqids sobre uma sequência

- Codifica um inteiro sequencial em uma string curta.
- **Pros:** Sem colisões e com URLs muito curtas.
- **Cons:** A ordem pode ser inferida, o que enfraquece vídeos unlisted.

**Recommendation:** **Option A (base62 de 11 caracteres + `UNIQUE`)** — mantém a URL curta e adequada a links não listados sem adicionar dependência. Mesmo com 1 bilhão de vídeos, a chance de um novo slug colidir é de cerca de 2 × 10⁻¹¹, e a restrição do banco cobre esse caso.

**Decision:** _[pending]_

---

## TD-10: Execução do worker de vídeo

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** O diagrama define o worker como container separado. A escolha afeta build, compartilhamento de entidades e isolamento de CPU. O `Dockerfile.dev` atual não inclui FFmpeg. Depende de TD-01.

**Options:**

### Option A: Serviço `video-worker` no mesmo projeto NestJS

- Segundo entrypoint com `NestFactory.createApplicationContext`, sem servidor HTTP, e imagem com FFmpeg. Os binários são chamados com `child_process.spawn` e lista de argumentos.
- **Pros:** Reaproveita entidades, configuração e módulos. Isola a CPU da API e permite escalar réplicas.
- **Cons:** Exige disciplina nos imports para o worker não carregar módulos HTTP. A imagem fica maior.

### Option B: Subprojeto `video-worker/` separado

- Novo projeto com manifesto, build e testes próprios.
- **Pros:** Isolamento total de dependências e deploy.
- **Cons:** Duplica entidades e configuração ou exige um pacote compartilhado, sem necessidade nesta fase.

### Option C: Processos FFmpeg dentro do container da API

- A API consome a fila e dispara os processos.
- **Pros:** Nenhum serviço novo.
- **Cons:** Contraria a arquitetura e faz o processamento competir por CPU e memória com as requisições.

**Recommendation:** **Option A (mesmo código, container separado)** — cumpre o diagrama sem duplicar o domínio. Usar concorrência inicial de 1 job por réplica, e não adotar `fluent-ffmpeg`, que está marcado como descontinuado no npm.

**Decision:** _[pending]_

---

## TD-11: Extração de metadados e thumbnail sem cópia integral

**Scope:** Backend

**Capability:** Transversal — covers: "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** Copiar 10GB para cada job consumiria disco e tempo. O ffprobe e o ffmpeg precisam de acesso com seek, porque um MP4 pode ter o índice `moov` no final do arquivo. Depende de TD-04 e TD-10.

**Options:**

### Option A: Ler por URL pré-assinada interna com HTTP Range

- O worker assina uma URL curta em `S3_ENDPOINT`. O ffprobe lê os metadados, e o ffmpeg usa `-ss` antes de `-i` para extrair um frame.
- **Pros:** Sem cópia integral nem volume grande. Baixa apenas os trechos necessários.
- **Cons:** Depende da estabilidade da rede. A URL não pode vazar em logs, e arquivos sem índice podem exigir mais leitura.

### Option B: Baixar o arquivo completo

- Copia o objeto para um volume temporário antes de processar.
- **Pros:** Comportamento simples e independente da rede depois do download.
- **Cons:** Contraria o requisito e exige disco para o maior vídeo vezes a concorrência.

### Option C: Enviar o objeto por `stdin`

- Faz streaming de `GetObject` para o processo FFmpeg.
- **Pros:** Não grava o arquivo em disco.
- **Cons:** `stdin` não permite seek, o que quebra MP4 com `moov` no final e torna o acesso ao frame ineficiente.

**Recommendation:** **Option A (HTTP Range)** — é a opção que atende ao requisito sem perder compatibilidade com MP4. Usar `-protocol_whitelist` restrito, para um arquivo malicioso não acionar outros protocolos, além de timeout e redação da URL nos logs. A imagem Debian bookworm instala FFmpeg 5.1.9, portanto usar apenas opções existentes nessa versão (`reconnect_max_retries`, por exemplo, não existe nela). Thumbnail proposta: frame em 10% da duração, com fallback para o primeiro frame.

**Decision:** _[pending]_

---

## TD-12: Formatos aceitos para reprodução

**Scope:** Backend

**Capability:** Reprodução via streaming (sem necessidade de download completo)

**Context:** O plano não inclui transcodificação. Sem ela, um vídeo só toca no navegador se o contêiner e os codecs originais forem compatíveis. Marcar qualquer arquivo como `ready` criaria vídeos que não reproduzem. Depende de TD-11.

**Options:**

### Option A: Allowlist validada com ffprobe, sem transcodificar

- Aceita MP4/MOV e WebM com vídeo H.264, VP8, VP9 ou AV1 e áudio AAC, MP3, Opus ou Vorbis. Outros formatos terminam em `failed` com código `UNSUPPORTED_FORMAT`.
- **Pros:** Mantém o escopo do plano e garante que `ready` signifique reproduzível nos navegadores-alvo.
- **Cons:** Rejeita MKV, AVI e HEVC até existir transcodificação.

### Option B: Transcodificar tudo para MP4 H.264/AAC

- O worker gera uma versão compatível de cada upload.
- **Pros:** Aceita praticamente qualquer entrada e padroniza a reprodução.
- **Cons:** Adiciona uma capacidade fora do plano, com alto custo de CPU, tempo e armazenamento.

### Option C: Aceitar qualquer arquivo com faixa de vídeo

- Basta o ffprobe encontrar um stream de vídeo.
- **Pros:** Menos rejeições no upload.
- **Cons:** O status `ready` deixa de garantir reprodução, e o erro só aparece no player.

**Recommendation:** **Option A (allowlist sem transcodificação)** — respeita o escopo da fase e mantém o status confiável. A perda é real: parte dos arquivos comuns será recusada até uma fase futura decidir por transcodificação.

**Decision:** _[pending]_

---

## TD-13: Entrega de streaming com Range/206 e download

**Scope:** Cross-layer

**Capability:** Transversal — covers: "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** A API autentica com `Authorization: Bearer`, mas um elemento `<video>` não envia esse header. O diagrama indica streaming direto do storage, que já responde `206` a requisições Range. Nesta fase, o acesso fica restrito ao dono do canal. Depende de TD-04 e TD-12.

**Options:**

### Option A: API retorna URLs pré-assinadas em JSON

- `GET /videos/:id/playback` e `GET /videos/:id/download` autorizam o dono e retornam `{ url, expiresAt }`. O storage atende Range/206.
- **Impacto:** o frontend futuro obtém a URL pelo BFF e a usa no player ou no download.
- **Pros:** API fora do caminho dos bytes e contrato simples para o BFF. Download e reprodução diferem só nos headers assinados.
- **Cons:** A URL é uma credencial temporária, e o player precisa renovar quando ela expirar.

### Option B: API responde `302` para a URL pré-assinada

- A rota autoriza e redireciona ao storage.
- **Impacto:** o player pode usar uma rota estável do BFF.
- **Pros:** Facilita renovar a URL ao abrir o recurso novamente.
- **Cons:** Reconexões podem voltar por BFF e API, e o BFF precisa tratar o redirect sem expor tokens.

### Option C: API faz proxy dos bytes com Range

- O NestJS repassa o stream do storage ao cliente.
- **Impacto:** o frontend usa uma URL da própria aplicação.
- **Pros:** Controle total de acesso em cada requisição.
- **Cons:** Coloca todo o tráfego de vídeo na API, contrariando o objetivo de performance da fase.

**Recommendation:** **Option A (URLs pré-assinadas em JSON)** — aproveita o Range nativo do storage e funciona com o BFF já decidido. Assinar `ResponseContentType` com o tipo validado pelo ffprobe e `ResponseContentDisposition` (`inline` no streaming, `attachment` com nome sanitizado no download). Validade proposta: `max(1h, 2 × duração)` para streaming e 6h para download. As regras de acesso público ficam para as Fases 04 e 05.

**Decision:** _[pending]_

---

## TD-14: Modelo de status do vídeo

**Scope:** Backend

**Capability:** Transversal — covers: "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** O ciclo pedido é rascunho → processando → pronto/erro. A Fase 04 também usa "rascunho" para o fluxo de publicação, então um vídeo pronto ainda pode ser um rascunho editorial. O modelo precisa evitar essa ambiguidade. Depende de TD-01.

**Options:**

### Option A: Status do pipeline, separado da publicação futura

- Coluna `status` com `draft`, `processing`, `ready` e `failed`, alterada por `UPDATE` condicional. A Fase 04 adiciona seu próprio campo de publicação.
- **Pros:** Transições simples e auditáveis. `ready` não significa público, e a Fase 04 não precisa reinterpretar o processamento.
- **Cons:** A Fase 04 precisará combinar dois campos em consultas e no painel.

### Option B: Um único status incluindo publicação

- Uma coluna com `draft`, `processing`, `ready`, `failed` e `published`.
- **Pros:** Uma única coluna para consultar.
- **Cons:** Mistura processamento e decisão editorial e antecipa regras da Fase 04.

### Option C: Máquina de estados granular

- Estados como `uploading`, `uploaded`, `queued`, `probing` e `generating_thumbnail`.
- **Pros:** Mais visibilidade do progresso.
- **Cons:** Mais transições e testes, sem capability que exija esse detalhe.

**Recommendation:** **Option A (status do pipeline)** — preserva o ciclo pedido e deixa a publicação para a Fase 04. Com TD-01 Option D, a API faz commit de `draft → processing` com `job_enqueued_at` nulo, chama `SendMessage` e então preenche esse campo. Um reconciliador no `video-worker` reenvia vídeos em `processing` com `job_enqueued_at` nulo há mais de 1 minuto, usando `FOR UPDATE SKIP LOCKED`. Um eventual reenvio duplicado é seguro pelo TD-15. `processing → ready` grava duração, metadados e thumbnail em um único `UPDATE`.

**Decision:** _[pending]_

---

## TD-15: Retentativas, idempotência e tratamento de falhas

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de processamento em segundo plano (filas)", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo"

**Context:** Filas entregam jobs pelo menos uma vez. Um worker pode cair após gerar a thumbnail e antes de atualizar o banco, e falhas de rede não devem ser tratadas como arquivo inválido. Depende de TD-01, TD-03 e TD-14.

**Options:**

### Option A: At-least-once com handler idempotente e classificação de erros

- Erros transitórios usam retentativa com backoff. Erros permanentes marcam `failed` sem retry. Jobs esgotados vão para dead letter, cujo consumidor marca `failed`.
- **Pros:** Recupera falhas temporárias sem repetir trabalho inútil. Chave determinística e `UPDATE` condicional tornam a reexecução segura.
- **Cons:** Exige classificar erros e testar cenários de queda.

### Option B: Tentativa única com reprocessamento manual

- Qualquer falha marca `failed` e depende de uma ação posterior.
- **Pros:** Fluxo muito simples.
- **Cons:** Instabilidades curtas viram erro para o usuário, e a fase não prevê tela ou endpoint de reprocessamento.

### Option C: Controle próprio de tentativas no banco

- Uma tabela da aplicação guarda leases, tentativas e próxima execução.
- **Pros:** Controle total sobre a política.
- **Cons:** Reimplementa recursos que a fila já oferece.

**Recommendation:** **Option A (at-least-once idempotente)**. Valores iniciais com SQS:

- `maxReceiveCount: 4` (uma execução e até 3 retentativas), com retenção de 14 dias nas filas principal e DLQ.
- `VisibilityTimeout` de 120s, renovado a cada 40s por `ChangeMessageVisibility` enquanto o FFmpeg roda, com limite de 30 minutos por execução imposto pelo worker.
- Em erro transitório, ajustar a visibilidade para 30s, 60s e 120s, criando o backoff. Em erro permanente, marcar `failed` e chamar `DeleteMessage`.
- Um consumidor da DLQ marca o vídeo como `failed` com o código `PROCESSING_EXHAUSTED`.
- A escrita final usa `WHERE status = 'processing'`, então duplicatas não alteram um vídeo já concluído.

**Decision:** _[pending]_

---

## TD-16: Estratégia de testes com a infraestrutura real

**Scope:** Backend

**Capability:** Transversal — covers: "Serviço de armazenamento de arquivos (vídeos e thumbnails)", "Serviço de processamento em segundo plano (filas)", "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance", "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload", "Processamento automático do vídeo após upload (extração de duração e metadados)", "Geração automática de thumbnail a partir de um frame do vídeo", "URL única por vídeo, sem conflito com outros vídeos", "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário"

**Context:** Os riscos da fase estão nos contratos reais: assinatura, CORS, multipart, Range, FFmpeg e fila. O guia `testing-guide-nestjs-project` ainda prevê filesystem local para storage, o que não exercitaria esses contratos e conflita com a diretriz desta pesquisa.

**Options:**

### Option A: Pirâmide usando os serviços reais do Compose

- Unitários isolam regras puras. Integração usa PostgreSQL, MinIO, fila e FFmpeg reais. E2E usa `supertest` e faz upload real ao MinIO.
- **Pros:** Exercita os contratos de maior risco e segue o padrão atual de banco e Mailpit reais.
- **Cons:** Suítes mais lentas, execução serial e necessidade de isolar dados entre testes.

### Option B: Testcontainers

- Cada suíte cria seus próprios containers.
- **Pros:** Isolamento forte entre suítes.
- **Cons:** Exige acesso ao Docker de dentro do container de testes e diverge do ambiente Compose do projeto.

### Option C: Adaptadores locais e fakes

- Filesystem no lugar do S3 e fila simulada, como o guia atual sugere para storage.
- **Pros:** Testes rápidos e simples.
- **Cons:** Não detecta erros de assinatura, CORS, ETag, Range ou multipart.

**Recommendation:** **Option A (Compose real)**, com estas regras:

- Bucket `streamtube-test` e filas de teste dedicadas no ElasticMQ, limpas com `PurgeQueue`, com `--runInBand`.
- Permissões IAM e a integração com SQS real ficam para um smoke test na AWS, pois o ElasticMQ não autentica requisições.
- Fixtures pequenas geradas por FFmpeg, incluindo MP4 com `moov` no final, e um teste que confirme a leitura parcial.
- Teste do limite com valor reduzido por env, sem enviar 10GB na suíte. O upload real de 10GB fica como smoke test manual.
- Para testar URLs públicas dentro do container, conectar em `minio:9000` preservando `Host: localhost:9000` com `http.request`, pois `fetch` não permite definir esse header.
- Testes que dependem de FFmpeg rodam no container `video-worker`.

**Decision:** _[pending]_

---

## Decisions Summary

| ID | Scope | Decision | Recommendation | Choice |
|----|-------|----------|---------------|--------|
| TD-01 | Backend | Tecnologia da fila de processamento | D — SQS Standard + ElasticMQ local | _[pending]_ |
| TD-02 | Repo-wide | Obtenção da imagem local do MinIO | A — build da tag oficial fixada | _[pending]_ |
| TD-03 | Backend | Organização de buckets e chaves | A — um bucket com prefixo por `videoId` | _[pending]_ |
| TD-04 | Backend | Endpoints do storage e URLs pré-assinadas | A — endpoints interno e público | _[pending]_ |
| TD-05 | Cross-layer | Protocolo de upload de até 10GB | A — S3 Multipart pré-assinado | _[pending]_ |
| TD-06 | Backend | Pré-cadastro automático do rascunho | A — chamada única em `POST /videos` | _[pending]_ |
| TD-07 | Backend | Validação do tamanho real ao concluir | A — `ListParts` + `HeadObject` | _[pending]_ |
| TD-08 | Backend | Limpeza de uploads abandonados | A — varredura guiada pelo banco | _[pending]_ |
| TD-09 | Backend | Geração da URL única do vídeo | A — base62 de 11 caracteres + `UNIQUE` | _[pending]_ |
| TD-10 | Backend | Execução do worker de vídeo | A — `video-worker` no mesmo projeto | _[pending]_ |
| TD-11 | Backend | Extração sem cópia integral | A — HTTP Range com URL interna | _[pending]_ |
| TD-12 | Backend | Formatos aceitos para reprodução | A — allowlist sem transcodificação | _[pending]_ |
| TD-13 | Cross-layer | Entrega de streaming e download | A — URLs pré-assinadas em JSON | _[pending]_ |
| TD-14 | Backend | Modelo de status do vídeo | A — status do pipeline | _[pending]_ |
| TD-15 | Backend | Retentativas, idempotência e falhas | A — at-least-once idempotente | _[pending]_ |
| TD-16 | Backend | Estratégia de testes | A — pirâmide com Compose real | _[pending]_ |

---

## Evidências e limites da pesquisa

**Versões consultadas em 2026-11-22:** NestJS 11.1.16, TypeORM 0.3.28, `pg` 8.20.0, Jest 30.3.0, TypeScript 5.9.3 e Node 25.6.0 no container estão instalados. Candidatas ainda não instaladas: `@aws-sdk/client-sqs` 3.1175.0, ElasticMQ 1.7.1, `@nestjs/schedule` 6.1.3, `pg-boss` 12.39.0, `bullmq` 6.7.8, `@nestjs/bullmq` 12.0.2, `@aws-sdk/client-s3` 3.1175.0 e FFmpeg 5.1.9 do Debian bookworm.

**Divergências de documentação:** o context7 oferece documentação de versões próximas, mas não exatas, de BullMQ, pg-boss e AWS SDK. O README atual do ElasticMQ já descreve a linha 2.x, cujas chaves de configuração diferem da 1.7.1. A documentação do `@nestjs/schedule` reflete a linha 12, que é ESM-only. A documentação do FFmpeg reflete a versão atual, por isso suas opções HTTP foram conferidas no código da série 5.1.

**Verificado:**

- Comportamento do MinIO no código da tag `RELEASE.2025-10-15T17-29-55Z`: CORS global com `ETag`, `PutBucketCors` sem efeito, expiração de uploads e ausência de `MpuObjectSize`.
- Compatibilidade de um pacote ESM mínimo com o Node, o TypeScript e o Jest do projeto: Node e `tsc` funcionam, e o Jest só funciona com allowlist de transformação.

**Não executado, a validar na primeira tarefa de implementação:**

- `@aws-sdk/client-sqs` contra o ElasticMQ 1.7.1, incluindo DLQ, heartbeat e backoff por visibilidade.
- Build da imagem do MinIO e fluxo real de multipart, CORS e `Content-Length` assinado.
- Leitura parcial por Range com ffprobe e ffmpeg 5.1.9.

**Itens fora do escopo para tarefas separadas:**

- O Node 25 chegou ao fim de vida em 2026-06-01, e o container ainda o utiliza.
- O guia de testes precisa refletir o storage real se TD-16 Option A for escolhida.
- A regra de Docker Networking do `CLAUDE.md` precisa registrar a exceção de `S3_PUBLIC_ENDPOINT` se TD-04 Option A for escolhida.
