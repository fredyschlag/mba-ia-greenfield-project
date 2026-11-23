---
libs:
  "@aws-sdk/client-sqs":
    version: "3.1175.0"
    context7_id: "/aws/aws-sdk-js-v3/v3.1153.0"
    fetched_at: "2026-11-22T21:30:57-03:00"
  "@aws-sdk/client-s3":
    version: "3.1175.0"
    context7_id: "/aws/aws-sdk-js-v3/v3.1153.0"
    fetched_at: "2026-11-22T21:30:57-03:00"
  "@aws-sdk/s3-request-presigner":
    version: "3.1175.0"
    context7_id: "/aws/aws-sdk-js-v3/v3.1153.0"
    fetched_at: "2026-11-22T21:30:57-03:00"
  "@nestjs/schedule":
    version: "6.1.3"
    context7_id: "/nestjs/schedule"
    fetched_at: "2026-11-22T21:30:57-03:00"
  "@nestjs/throttler":
    version: "^6.5.0"
    context7_id: "/nestjs/throttler"
    fetched_at: "2026-11-22T21:30:57-03:00"
sources_mtime:
  docs/decisions/technical-decisions-phase-03-videos.md: "2026-11-22T21:39:28-03:00"
---

# Library References — phase-03-videos

Referências destiladas do context7 para as superfícies usadas pelos TDs decididos. FFmpeg, MinIO e ElasticMQ são binários ou serviços e não entram neste arquivo.

### @aws-sdk/client-sqs

**Usado por:** `phase-03-videos/TD-01`.

**Divergência de versão:** a versão fixada é `3.1175.0`, e a documentação mais próxima no context7 é `v3.1153.0`. A versão fixada existe no npm e exige Node `>=20.0.0`.

- Com endpoint customizado (ElasticMQ), definir `endpoint` no `SQSClient` e também informar o `QueueUrl` correspondente em cada comando.
- `ChangeMessageVisibilityCommand` recebe `QueueUrl`, `ReceiptHandle` e `VisibilityTimeout`. É a operação usada para heartbeat e backoff.

```typescript
const sqs = new SQSClient({ region, endpoint: config.sqsEndpoint });
await sqs.send(
  new ChangeMessageVisibilityCommand({ QueueUrl, ReceiptHandle, VisibilityTimeout: 120 }),
);
```

### @aws-sdk/client-s3

**Usado por:** `phase-03-videos/TD-04`, `phase-03-videos/TD-05`, `phase-03-videos/TD-07`.

**Divergência de versão:** a versão fixada é `3.1175.0`, e a documentação mais próxima no context7 é `v3.1153.0`. A versão fixada existe no npm e exige Node `>=20.0.0`.

- A opção de path-style na v3 chama-se `forcePathStyle`. `endpoint` aceita uma URL em string.
- TD-04 exige dois clientes, um com o endpoint interno e outro com o endpoint público usado para assinar URLs.
- Desde a `v3.729.0`, o SDK usa checksums modernos, como CRC32, por padrão. `requestChecksumCalculation` e `responseChecksumValidation` aceitam `WHEN_REQUIRED` ou `WHEN_SUPPORTED`.
- TD-04 fixa `requestChecksumCalculation: 'WHEN_REQUIRED'` no cliente de presign, para não incluir checksum automático em URLs de `UploadPart`.
- **A validar na implementação:** a documentação retornada não descreve o efeito do padrão em URLs pré-assinadas. O primeiro teste real de multipart deve confirmar o comportamento do TD-04 no MinIO.

```typescript
const presignS3 = new S3Client({
  region,
  endpoint: config.s3PublicEndpoint,
  forcePathStyle: true,
  requestChecksumCalculation: 'WHEN_REQUIRED',
});
```

### @aws-sdk/s3-request-presigner

**Usado por:** `phase-03-videos/TD-04`, `phase-03-videos/TD-05`, `phase-03-videos/TD-13`.

**Divergência de versão:** a versão fixada é `3.1175.0`, e a documentação mais próxima no context7 é `v3.1153.0`. A versão fixada existe no npm e exige Node `>=20.0.0`.

- `getSignedUrl(client, command, { expiresIn })` assina qualquer comando S3. O padrão de `expiresIn` é 900 segundos.
- Headers que não sejam `x-amz-*` entram na assinatura por `signableHeaders`.
- Headers `x-amz-*` que precisam ser exigidos no request vão em `unhoistableHeaders`.
- **A validar na implementação:** o exemplo oficial usa `content-type`. O `Content-Length` assinado por parte, exigido pelo TD-05, deve ser confirmado contra o MinIO e o S3.

```typescript
const url = await getSignedUrl(
  presignS3,
  new UploadPartCommand({ Bucket, Key, UploadId, PartNumber, ContentLength }),
  { expiresIn: 3600, signableHeaders: new Set(['content-length']) },
);
```

### @nestjs/schedule

**Usado por:** `phase-03-videos/TD-08`.

**Divergência de versão:** a versão fixada é `6.1.3`, mas o context7 só oferece a tag `3.0.4` e a documentação sem versão do repositório. O guia do NestJS foi consultado na branch `11.0.0`. O pacote `6.1.3` declara suporte a NestJS `^10.0.0 || ^11.0.0`, compatível com o `11.1.16` instalado. A versão mais recente no npm é `12.0.4`, voltada a NestJS 11 e 12.

- Registrar `ScheduleModule.forRoot()` no módulo raiz do `video-worker`, onde o TD-08 executa a varredura. Os jobs declarativos são registrados em `onApplicationBootstrap`.
- `@Cron(expression, options)` e `@Interval(name?, ms)` declaram as tarefas.
- A documentação sem versão lista `name`, `timeZone`, `utcOffset`, `unrefTimeout`, `waitForCompletion`, `disabled`, `threshold` e `initialDelay` em `CronOptions`.
- **A validar na implementação:** confirmar nos tipos da `6.1.3` as opções usadas, em especial `waitForCompletion`, que evita varreduras sobrepostas.

```typescript
@Cron(CronExpression.EVERY_HOUR, { name: 'abandoned-uploads', waitForCompletion: true })
async sweepAbandonedUploads(): Promise<void> {}
```

### @nestjs/throttler

**Usado por:** `phase-03-videos/TD-17`.

**Divergência de versão:** o intervalo fixado é `^6.5.0`, e o context7 retorna a documentação sem versão da branch `master`. O projeto tem `6.5.0` instalado, e a versão mais recente no npm é `6.8.0`. Os tipos instalados confirmam que `@Throttle` aceita `limit`, `ttl`, `blockDuration`, `getTracker` e `generateKey` por rota.

- `@Throttle({ default: { ... } })` sobrescreve apenas os campos listados do throttler `default`.
- `getTracker` recebe o `Request` e o `ExecutionContext`, e retorna a chave de rastreamento.
- `ttl` e `blockDuration` são expressos em milissegundos.
- O projeto registra `JwtAuthGuard` antes de `ThrottlerGuard` em `nestjs-project/src/auth/auth.module.ts`, então `req.user.sub` está disponível no `getTracker` das rotas autenticadas. Essa ordem precisa ser preservada.

```typescript
@Throttle({
  default: { limit, ttl: 60_000, getTracker: (req) => req.user.sub },
})
```
