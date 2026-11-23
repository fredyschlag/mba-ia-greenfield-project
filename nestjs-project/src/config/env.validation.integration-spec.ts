import { envValidationSchema } from './env.validation';

const requiredEnv = {
  DB_USERNAME: 'user',
  DB_PASSWORD: 'pass',
  DB_NAME: 'db',
  JWT_SECRET: 'secret',
  JWT_REFRESH_SECRET: 'refresh-secret',
  S3_PUBLIC_ENDPOINT: 'http://localhost:9000',
  S3_REGION: 'us-east-1',
  S3_BUCKET: 'streamtube',
  SQS_REGION: 'us-east-1',
  SQS_VIDEO_PROCESSING_QUEUE_URL:
    'http://elasticmq:9324/000000000000/video-processing',
  SQS_VIDEO_PROCESSING_DLQ_URL:
    'http://elasticmq:9324/000000000000/video-processing-dlq',
};

const validate = (env: Record<string, string>) =>
  envValidationSchema.validate(
    { ...requiredEnv, ...env },
    { allowUnknown: true, abortEarly: false },
  );

const validateWithout = (key: keyof typeof requiredEnv) => {
  const env: Partial<typeof requiredEnv> = { ...requiredEnv };
  delete env[key];
  return envValidationSchema.validate(env, {
    allowUnknown: true,
    abortEarly: false,
  });
};

describe('envValidationSchema — video infrastructure', () => {
  it.each([
    'S3_PUBLIC_ENDPOINT',
    'S3_REGION',
    'S3_BUCKET',
    'SQS_REGION',
    'SQS_VIDEO_PROCESSING_QUEUE_URL',
    'SQS_VIDEO_PROCESSING_DLQ_URL',
  ] as const)('should reject a missing %s', (key) => {
    const { error } = validateWithout(key);
    expect(error).toBeDefined();
    expect(error!.message).toContain(key);
  });

  it('should accept the AWS setup without local endpoints or static credentials', () => {
    const result = validate({});
    expect(result.error).toBeUndefined();
    expect(result.value).not.toHaveProperty('S3_ENDPOINT');
    expect(result.value).not.toHaveProperty('SQS_ENDPOINT');
    expect(result.value).not.toHaveProperty('AWS_ACCESS_KEY_ID');
    expect(result.value).not.toHaveProperty('AWS_SECRET_ACCESS_KEY');
  });

  it('should accept local endpoints and static credentials', () => {
    const { error } = validate({
      S3_ENDPOINT: 'http://minio:9000',
      SQS_ENDPOINT: 'http://elasticmq:9324',
      AWS_ACCESS_KEY_ID: 'streamtube',
      AWS_SECRET_ACCESS_KEY: 'streamtube-dev-secret',
    });
    expect(error).toBeUndefined();
  });

  it.each([
    'S3_ENDPOINT',
    'S3_PUBLIC_ENDPOINT',
    'SQS_ENDPOINT',
    'SQS_VIDEO_PROCESSING_QUEUE_URL',
    'SQS_VIDEO_PROCESSING_DLQ_URL',
  ])('should reject %s when it is not a URI', (key) => {
    const { error } = validate({ [key]: 'not a uri' });
    expect(error).toBeDefined();
    expect(error!.message).toContain(key);
  });

  it('should default VIDEO_MAX_UPLOAD_BYTES to 10 GiB', () => {
    const result = validate({});
    expect(result.error).toBeUndefined();
    expect(
      (result.value as { VIDEO_MAX_UPLOAD_BYTES: number })
        .VIDEO_MAX_UPLOAD_BYTES,
    ).toBe(10_737_418_240);
  });

  it('should accept a reduced VIDEO_MAX_UPLOAD_BYTES', () => {
    const result = validate({ VIDEO_MAX_UPLOAD_BYTES: '1048576' });
    expect(result.error).toBeUndefined();
    expect(
      (result.value as { VIDEO_MAX_UPLOAD_BYTES: number })
        .VIDEO_MAX_UPLOAD_BYTES,
    ).toBe(1_048_576);
  });

  it.each(['0', '-1', '1.5', 'abc'])(
    'should reject VIDEO_MAX_UPLOAD_BYTES=%s',
    (invalid) => {
      const { error } = validate({ VIDEO_MAX_UPLOAD_BYTES: invalid });
      expect(error).toBeDefined();
      expect(error!.message).toContain('VIDEO_MAX_UPLOAD_BYTES');
    },
  );
});

describe('envValidationSchema — SWAGGER_ENABLED', () => {
  it('should reject SWAGGER_ENABLED with an invalid value', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'invalid' });
    expect(error).toBeDefined();
    expect(error!.message).toContain('SWAGGER_ENABLED');
  });

  it('should accept SWAGGER_ENABLED=true', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'true' });
    expect(error).toBeUndefined();
  });

  it('should accept SWAGGER_ENABLED=false', () => {
    const { error } = validate({ SWAGGER_ENABLED: 'false' });
    expect(error).toBeUndefined();
  });

  it('should apply default false when SWAGGER_ENABLED is not set', () => {
    const result = validate({});
    expect(result.error).toBeUndefined();
    const { SWAGGER_ENABLED } = result.value as { SWAGGER_ENABLED: string };
    expect(SWAGGER_ENABLED).toBe('false');
  });
});
