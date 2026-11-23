---
kind: phase
name: phase-03-videos
status: clean
issue_count: 0
sources_mtime:
  docs/phases/phase-03-videos/context.md: "2026-11-22T21:39:28-03:00"
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-22T21:39:28-03:00"
issues:
  - id: IC-1
    status: resolved
    summary: "Guia de testes admite storage local; TD-16 recomenda MinIO real"
    resolved_by: phase-03-videos/TD-16
  - id: AMB-1
    status: resolved
    summary: "Limite de 10GB não define base decimal ou binária"
    resolved_by: clarification
  - id: AMB-2
    status: resolved
    summary: "Acesso a streaming e download antes da visibilidade da Fase 04"
    resolved_by: clarification
  - id: AMB-3
    status: resolved
    summary: "Rascunho pode significar upload ou estado editorial da Fase 04"
    resolved_by: clarification
  - id: AMB-4
    status: resolved
    summary: "Validade do playback não tem teto para o limite de 7 dias do SigV4"
    resolved_by: phase-03-videos/TD-13
  - id: AMB-5
    status: resolved
    summary: "Queda entre concluir multipart e draft → processing não tem recuperação"
    resolved_by: phase-03-videos/TD-08
  - id: ICC-1
    status: resolved
    summary: "TD-17 limita rotas de vídeo; TD-08 herdado restringe throttling ao AuthModule"
    resolved_by: phase-02-auth/TD-08
  - id: OQ-1
    status: resolved
    summary: "TD-01 pending — Tecnologia da fila de processamento"
    resolved_by: phase-03-videos/TD-01
  - id: OQ-2
    status: resolved
    summary: "TD-02 pending — Obtenção da imagem local do MinIO"
    resolved_by: phase-03-videos/TD-02
  - id: OQ-3
    status: resolved
    summary: "TD-03 pending — Organização de buckets e chaves"
    resolved_by: phase-03-videos/TD-03
  - id: OQ-4
    status: resolved
    summary: "TD-04 pending — Endpoints do storage e URLs pré-assinadas"
    resolved_by: phase-03-videos/TD-04
  - id: OQ-5
    status: resolved
    summary: "TD-05 pending — Protocolo de upload de até 10GB"
    resolved_by: phase-03-videos/TD-05
  - id: OQ-6
    status: resolved
    summary: "TD-06 pending — Pré-cadastro automático do rascunho"
    resolved_by: phase-03-videos/TD-06
  - id: OQ-7
    status: resolved
    summary: "TD-07 pending — Validação do tamanho real ao concluir o upload"
    resolved_by: phase-03-videos/TD-07
  - id: OQ-8
    status: resolved
    summary: "TD-08 pending — Limpeza de uploads abandonados"
    resolved_by: phase-03-videos/TD-08
  - id: OQ-9
    status: resolved
    summary: "TD-09 pending — Geração da URL única do vídeo"
    resolved_by: phase-03-videos/TD-09
  - id: OQ-10
    status: resolved
    summary: "TD-10 pending — Execução do worker de vídeo"
    resolved_by: phase-03-videos/TD-10
  - id: OQ-11
    status: resolved
    summary: "TD-11 pending — Extração de metadados e thumbnail sem cópia integral"
    resolved_by: phase-03-videos/TD-11
  - id: OQ-12
    status: resolved
    summary: "TD-12 pending — Formatos aceitos para reprodução"
    resolved_by: phase-03-videos/TD-12
  - id: OQ-13
    status: resolved
    summary: "TD-13 pending — Entrega de streaming com Range/206 e download"
    resolved_by: phase-03-videos/TD-13
  - id: OQ-14
    status: resolved
    summary: "TD-14 pending — Modelo de status do vídeo"
    resolved_by: phase-03-videos/TD-14
  - id: OQ-15
    status: resolved
    summary: "TD-15 pending — Retentativas, idempotência e tratamento de falhas"
    resolved_by: phase-03-videos/TD-15
  - id: OQ-16
    status: resolved
    summary: "TD-16 pending — Estratégia de testes com a infraestrutura real"
    resolved_by: phase-03-videos/TD-16
  - id: OQ-17
    status: resolved
    summary: "TD-17 pending — Política de limites dos endpoints de vídeo"
    resolved_by: phase-03-videos/TD-17
  - id: OQ-18
    status: resolved
    summary: "TD-18 pending — Destino dos objetos de vídeos em `failed`"
    resolved_by: phase-03-videos/TD-18
advisories: []
---

# phase-03-videos — Validation

## Findings

_A severidade é uma classificação auxiliar de impacto. Toda issue aberta bloqueia `/plan-build`, independentemente da severidade._

### Inconsistencies

_None._

### Ambiguities

_None._

### Missing Decisions

_None._

### Dependency Gaps

_None._

### Inherited Constraint Conflicts

_None._

### Unresolved Open Questions

_None._

### UI Coverage Gaps

_None._

## Resolved Issues

- **IC-1** _(resolved_by phase-03-videos/TD-16)_ — Guia de testes admite storage local; TD-16 recomenda MinIO real. A infraestrutura real do TD-16 prevalece nesta fase, e a atualização do guia de testes é uma tarefa separada.
- **AMB-1** _(resolved_by clarification)_ — Limite de 10GB não define base decimal ou binária. O limite é 10 GiB, exatamente 10.737.418.240 bytes.
- **AMB-2** _(resolved_by clarification)_ — Acesso a streaming e download antes da visibilidade da Fase 04. Streaming e download ficam restritos ao dono autenticado do canal e a vídeos em `ready`, conforme o TD-13. As regras públicas ficam para as Fases 04 e 05.
- **AMB-3** _(resolved_by clarification)_ — Rascunho pode significar upload ou estado editorial da Fase 04. `draft` é um estado do pipeline, separado do estado de publicação da Fase 04, conforme o TD-14.
- **OQ-1** _(resolved_by phase-03-videos/TD-01)_ — TD-01 pending — Tecnologia da fila de processamento. Decision: D (SQS Standard + ElasticMQ).
- **OQ-2** _(resolved_by phase-03-videos/TD-02)_ — TD-02 pending — Obtenção da imagem local do MinIO. Decision: A (Build local da tag oficial fixada).
- **OQ-3** _(resolved_by phase-03-videos/TD-03)_ — TD-03 pending — Organização de buckets e chaves. Decision: A (Um bucket privado com prefixo por vídeo).
- **OQ-4** _(resolved_by phase-03-videos/TD-04)_ — TD-04 pending — Endpoints do storage e URLs pré-assinadas. Decision: A (Dois endpoints explícitos).
- **OQ-5** _(resolved_by phase-03-videos/TD-05)_ — TD-05 pending — Protocolo de upload de até 10GB. Decision: A (S3 Multipart com URLs pré-assinadas).
- **OQ-6** _(resolved_by phase-03-videos/TD-06)_ — TD-06 pending — Pré-cadastro automático do rascunho. Decision: A (Chamada única cria upload e rascunho).
- **OQ-7** _(resolved_by phase-03-videos/TD-07)_ — TD-07 pending — Validação do tamanho real ao concluir o upload. Decision: A (ListParts + HeadObject).
- **OQ-8** _(resolved_by phase-03-videos/TD-08)_ — TD-08 pending — Limpeza de uploads abandonados. Decision: A (Varredura guiada pelo banco).
- **OQ-9** _(resolved_by phase-03-videos/TD-09)_ — TD-09 pending — Geração da URL única do vídeo. Decision: A (Slug base62 + UNIQUE).
- **OQ-10** _(resolved_by phase-03-videos/TD-10)_ — TD-10 pending — Execução do worker de vídeo. Decision: A (video-worker no mesmo projeto).
- **OQ-11** _(resolved_by phase-03-videos/TD-11)_ — TD-11 pending — Extração de metadados e thumbnail sem cópia integral. Decision: A (HTTP Range com URL interna).
- **OQ-12** _(resolved_by phase-03-videos/TD-12)_ — TD-12 pending — Formatos aceitos para reprodução. Decision: A (Allowlist sem transcodificação).
- **OQ-13** _(resolved_by phase-03-videos/TD-13)_ — TD-13 pending — Entrega de streaming com Range/206 e download. Decision: A (URLs pré-assinadas em JSON).
- **OQ-14** _(resolved_by phase-03-videos/TD-14)_ — TD-14 pending — Modelo de status do vídeo. Decision: A (Status do pipeline).
- **OQ-15** _(resolved_by phase-03-videos/TD-15)_ — TD-15 pending — Retentativas, idempotência e tratamento de falhas. Decision: A (At-least-once idempotente).
- **OQ-16** _(resolved_by phase-03-videos/TD-16)_ — TD-16 pending — Estratégia de testes com a infraestrutura real. Decision: A (Pirâmide com Compose real).
- **OQ-17** _(resolved_by phase-03-videos/TD-17)_ — TD-17 pending — Política de limites dos endpoints de vídeo. Decision: A (@Throttle por usuário + limite de uploads ativos).
- **OQ-18** _(resolved_by phase-03-videos/TD-18)_ — TD-18 pending — Destino dos objetos de vídeos em `failed`. Decision: D (Retenção por classe de falha).
- **AMB-4** _(resolved_by phase-03-videos/TD-13)_ — Validade do playback não tem teto para o limite de 7 dias do SigV4. Revisão no TD-13: validade `min(7 dias, max(1h, 2 × duração))`.
- **AMB-5** _(resolved_by phase-03-videos/TD-08)_ — Queda entre concluir multipart e draft → processing não tem recuperação. O TD-07 já cobre a nova tentativa. Revisão no TD-08: a varredura remove o `source` de rascunhos expirados antes de apagar o registro.
- **ICC-1** _(resolved_by phase-02-auth/TD-08)_ — TD-17 limita rotas de vídeo; TD-08 herdado restringe throttling ao AuthModule. Revisão no TD herdado: o guard é global, e as rotas de vídeo seguem o TD-17.
