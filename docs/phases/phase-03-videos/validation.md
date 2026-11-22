---
kind: phase
name: phase-03-videos
status: dirty
issue_count: 22
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-22T20:19:01-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-22T20:14:46-03:00"
issues:
  - id: IC-1
    status: open
    summary: "Guia de testes admite storage local; TD-16 recomenda MinIO real"
  - id: AMB-1
    status: open
    summary: "Limite de 10GB não define base decimal ou binária"
  - id: AMB-2
    status: open
    summary: "Acesso a streaming e download antes da visibilidade da Fase 04"
  - id: AMB-3
    status: open
    summary: "Rascunho pode significar upload ou estado editorial da Fase 04"
  - id: MD-1
    status: open
    summary: "Sem política de limites para endpoints de upload e vídeo"
  - id: MD-2
    status: open
    summary: "Sem política de retenção para objetos de vídeos em falha"
  - id: OQ-1
    status: open
    summary: "TD-01 pending — Tecnologia da fila de processamento"
  - id: OQ-2
    status: open
    summary: "TD-02 pending — Obtenção da imagem local do MinIO"
  - id: OQ-3
    status: open
    summary: "TD-03 pending — Organização de buckets e chaves"
  - id: OQ-4
    status: open
    summary: "TD-04 pending — Endpoints do storage e URLs pré-assinadas"
  - id: OQ-5
    status: open
    summary: "TD-05 pending — Protocolo de upload de até 10GB"
  - id: OQ-6
    status: open
    summary: "TD-06 pending — Pré-cadastro automático do rascunho"
  - id: OQ-7
    status: open
    summary: "TD-07 pending — Validação do tamanho real ao concluir o upload"
  - id: OQ-8
    status: open
    summary: "TD-08 pending — Limpeza de uploads abandonados"
  - id: OQ-9
    status: open
    summary: "TD-09 pending — Geração da URL única do vídeo"
  - id: OQ-10
    status: open
    summary: "TD-10 pending — Execução do worker de vídeo"
  - id: OQ-11
    status: open
    summary: "TD-11 pending — Extração de metadados e thumbnail sem cópia integral"
  - id: OQ-12
    status: open
    summary: "TD-12 pending — Formatos aceitos para reprodução"
  - id: OQ-13
    status: open
    summary: "TD-13 pending — Entrega de streaming com Range/206 e download"
  - id: OQ-14
    status: open
    summary: "TD-14 pending — Modelo de status do vídeo"
  - id: OQ-15
    status: open
    summary: "TD-15 pending — Retentativas, idempotência e tratamento de falhas"
  - id: OQ-16
    status: open
    summary: "TD-16 pending — Estratégia de testes com a infraestrutura real"
advisories: []
---

# phase-03-videos — Validation

## Findings

_A severidade é uma classificação auxiliar de impacto. Toda issue aberta bloqueia `/plan-build`, independentemente da severidade._

### Inconsistencies

- **IC-1** — Severidade: alta. Afeta `phase-03-videos/TD-16` e `## Testing Requirements`. O guia `testing-guide-nestjs-project` define para serviços com storage "real capture service (Mailpit) or local adapter", e `references/external-systems.md` define "Local filesystem storage in development and tests". O TD-16, ainda pendente, recomenda testar com o MinIO real do Compose. Explicit choice: (a) escolher a infraestrutura real no TD-16 e registrar a atualização do guia como tarefa separada; (b) manter o adaptador local e aceitar que assinatura, CORS, ETag, Range e multipart não serão exercitados nos testes.

### Ambiguities

- **AMB-1** — Severidade: média. Afeta "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance" e `phase-03-videos/TD-05`, `phase-03-videos/TD-07` e `phase-03-videos/TD-16`. "10GB" pode significar 10.000.000.000 bytes ou 10 GiB (10.737.418.240 bytes), e o valor define a validação da API, a variável de ambiente e os testes de limite. Explicit choice: confirmar o limite exato em bytes ao decidir o TD-05.
- **AMB-2** — Severidade: alta. Afeta "Reprodução via streaming (sem necessidade de download completo)", "Download do vídeo pelo usuário" e `phase-03-videos/TD-13`. A visibilidade pertence à Fase 04, mas estas capacidades são entregues antes dela, e "usuário" não define quem pode acessar um vídeo nesta fase. Explicit choice: confirmar se, na Fase 03, streaming e download ficam restritos ao dono autenticado do canal, com as regras públicas adiadas para as Fases 04 e 05.
- **AMB-3** — Severidade: média. Afeta "Pré-cadastro automático do vídeo como rascunho ao iniciar o upload" e `phase-03-videos/TD-14`. "Rascunho" pode descrever o estado inicial do pipeline ou o estado editorial do fluxo de publicação da Fase 04, o que deixa indefinido se um vídeo processado continua sendo rascunho. Explicit choice: confirmar no TD-14 se o status do pipeline fica separado do estado de publicação.

### Missing Decisions

- **MD-1** — Severidade: alta. Afeta "Upload de vídeos com suporte a arquivos de até 10GB sem impacto na performance" e o herdado `phase-02-auth/TD-08`. O TD herdado descreve o throttling como restrito ao `AuthModule`, mas `nestjs-project/src/auth/auth.module.ts` registra `ThrottlerGuard` com `APP_GUARD`, que o NestJS aplica globalmente. Os novos endpoints de vídeo herdariam esse limite, e nenhum TD define limites para assinatura de partes, retomada, consultas de reprodução ou uploads simultâneos por canal. Explicit choice: adicionar um TD com a política de limites desses endpoints, incluindo exceções ao throttler global e o máximo de uploads ativos por canal.
- **MD-2** — Severidade: média. Afeta "Serviço de armazenamento de arquivos (vídeos e thumbnails)", `phase-03-videos/TD-08`, `phase-03-videos/TD-12` e `phase-03-videos/TD-15`. O TD-08 trata de uploads abandonados, mas nenhum TD indexado define o destino de um objeto de até 10GB quando o vídeo termina em `failed`, e a fase não prevê fluxo de exclusão. Explicit choice: adicionar um TD escolhendo entre remover o objeto na falha permanente, retê-lo por um prazo definido ou mantê-lo até existir um fluxo de exclusão.

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._

### Unresolved Open Questions

- **OQ-1** — Severidade: alta. TD-01 pending — Tecnologia da fila de processamento. Resolution: fill the **Decision:** field of TD-01 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run `/plan-validate phase-03-videos`.
- **OQ-2** — Severidade: alta. TD-02 pending — Obtenção da imagem local do MinIO. Resolution: fill the **Decision:** field of TD-02 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run `/plan-validate phase-03-videos`.
- **OQ-3** — Severidade: média. TD-03 pending — Organização de buckets e chaves. Resolution: fill the **Decision:** field of TD-03 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run `/plan-validate phase-03-videos`.
- **OQ-4** — Severidade: alta. TD-04 pending — Endpoints do storage e URLs pré-assinadas. Resolution: fill the **Decision:** field of TD-04 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run `/plan-validate phase-03-videos`.
- **OQ-5** — Severidade: alta. TD-05 pending — Protocolo de upload de até 10GB. Resolution: fill the **Decision:** field of TD-05 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run `/plan-validate phase-03-videos`.
- **OQ-6** — Severidade: média. TD-06 pending — Pré-cadastro automático do rascunho. Resolution: fill the **Decision:** field of TD-06 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run `/plan-validate phase-03-videos`.
- **OQ-7** — Severidade: média. TD-07 pending — Validação do tamanho real ao concluir o upload. Resolution: fill the **Decision:** field of TD-07 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run `/plan-validate phase-03-videos`.
- **OQ-8** — Severidade: média. TD-08 pending — Limpeza de uploads abandonados. Resolution: fill the **Decision:** field of TD-08 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run `/plan-validate phase-03-videos`.
- **OQ-9** — Severidade: média. TD-09 pending — Geração da URL única do vídeo. Resolution: fill the **Decision:** field of TD-09 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run `/plan-validate phase-03-videos`.
- **OQ-10** — Severidade: média. TD-10 pending — Execução do worker de vídeo. Resolution: fill the **Decision:** field of TD-10 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run `/plan-validate phase-03-videos`.
- **OQ-11** — Severidade: média. TD-11 pending — Extração de metadados e thumbnail sem cópia integral. Resolution: fill the **Decision:** field of TD-11 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run `/plan-validate phase-03-videos`.
- **OQ-12** — Severidade: alta. TD-12 pending — Formatos aceitos para reprodução. Resolution: fill the **Decision:** field of TD-12 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run `/plan-validate phase-03-videos`.
- **OQ-13** — Severidade: alta. TD-13 pending — Entrega de streaming com Range/206 e download. Resolution: fill the **Decision:** field of TD-13 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run `/plan-validate phase-03-videos`.
- **OQ-14** — Severidade: alta. TD-14 pending — Modelo de status do vídeo. Resolution: fill the **Decision:** field of TD-14 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run `/plan-validate phase-03-videos`.
- **OQ-15** — Severidade: média. TD-15 pending — Retentativas, idempotência e tratamento de falhas. Resolution: fill the **Decision:** field of TD-15 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run `/plan-validate phase-03-videos`.
- **OQ-16** — Severidade: alta. TD-16 pending — Estratégia de testes com a infraestrutura real. Resolution: fill the **Decision:** field of TD-16 in `docs/decisions/technical-decisions-phase-03-videos.md`, then re-run `/plan-validate phase-03-videos`.

### UI Coverage Gaps

_None._

## Resolved Issues

_No issues resolved yet._
