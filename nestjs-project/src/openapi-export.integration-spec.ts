import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportSpec } from './openapi-export';

describe('exportSpec (integration)', () => {
  let outputPath: string;
  let document: Record<string, unknown>;

  beforeAll(async () => {
    outputPath = join(tmpdir(), `openapi-test-${Date.now()}.json`);
    await exportSpec(outputPath);
    document = JSON.parse(readFileSync(outputPath, 'utf-8')) as Record<
      string,
      unknown
    >;
  }, 30_000);

  it('exports a valid OpenAPI 3.x document', () => {
    expect(document.openapi).toMatch(/^3\./);
  });

  it('sets info.title to "StreamTube API"', () => {
    const info = document.info as Record<string, unknown>;
    expect(info.title).toBe('StreamTube API');
  });

  it('sets info.version to "1.0"', () => {
    const info = document.info as Record<string, unknown>;
    expect(info.version).toBe('1.0');
  });

  it('includes access-token Bearer security scheme', () => {
    const components = document.components as Record<string, unknown>;
    const schemes = components.securitySchemes as Record<
      string,
      Record<string, unknown>
    >;
    expect(schemes['access-token']).toMatchObject({
      type: 'http',
      scheme: 'bearer',
      bearerFormat: 'JWT',
    });
  });

  it('includes non-empty components.schemas from DTO inference', () => {
    const components = document.components as Record<string, unknown>;
    const schemas = components.schemas as Record<string, unknown>;
    expect(Object.keys(schemas).length).toBeGreaterThan(0);
  });

  it('includes ApiErrorEnvelope schema with expected properties', () => {
    const components = document.components as Record<string, unknown>;
    const schemas = components.schemas as Record<
      string,
      Record<string, unknown>
    >;
    expect(schemas['ApiErrorEnvelope']).toBeDefined();
    const props = schemas['ApiErrorEnvelope'].properties as Record<
      string,
      unknown
    >;
    expect(props).toHaveProperty('statusCode');
    expect(props).toHaveProperty('error');
    expect(props).toHaveProperty('message');
    expect(props).toHaveProperty('code');
  });

  it('has at least one path with a 401 response referencing ApiErrorEnvelope', () => {
    const paths = document.paths as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    const apiErrorRef = '#/components/schemas/ApiErrorEnvelope';

    const hasRef = Object.values(paths).some((methods) =>
      Object.values(methods).some((operation) => {
        const responses = operation.responses as Record<
          string,
          Record<string, unknown>
        >;
        const r401 = responses?.['401'];
        if (!r401) return false;
        const content = r401.content as Record<string, Record<string, unknown>>;
        const jsonContent = content?.['application/json'];
        const schema = jsonContent?.schema as Record<string, unknown>;
        return schema?.['$ref'] === apiErrorRef;
      }),
    );

    expect(hasRef).toBe(true);
  });

  it('protected auth endpoints include access-token security requirement', () => {
    const paths = document.paths as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    const protectedPaths = [
      { path: '/auth/logout', method: 'post' },
      { path: '/auth/me', method: 'get' },
    ];

    for (const { path, method } of protectedPaths) {
      const operation = paths[path]?.[method];
      expect(operation).toBeDefined();
      const security = operation?.security as Array<Record<string, unknown>>;
      expect(security).toBeDefined();
      expect(security.some((req) => 'access-token' in req)).toBe(true);
    }
  });

  it('all auth endpoints have a non-empty summary', () => {
    const paths = document.paths as Record<
      string,
      Record<string, Record<string, unknown>>
    >;
    const authPaths = Object.entries(paths).filter(([p]) =>
      p.startsWith('/auth/'),
    );

    expect(authPaths.length).toBeGreaterThan(0);

    for (const [, methods] of authPaths) {
      for (const operation of Object.values(methods)) {
        expect(typeof operation.summary).toBe('string');
        expect((operation.summary as string).length).toBeGreaterThan(0);
      }
    }
  });

  describe('video endpoints', () => {
    const apiErrorRef = '#/components/schemas/ApiErrorEnvelope';
    const videoOperations = [
      {
        path: '/videos',
        method: 'post',
        success: '201',
        errors: ['400', '401', '404', '409', '413', '429'],
      },
      {
        path: '/videos/{id}/upload/part-urls',
        method: 'post',
        success: '201',
        errors: ['400', '401', '404', '409', '410', '429'],
      },
      {
        path: '/videos/{id}/upload/parts',
        method: 'get',
        success: '200',
        // ParseUUIDPipe answers 400 for a malformed :id.
        errors: ['400', '401', '404', '409', '410', '429'],
      },
      {
        path: '/videos/{id}/upload/complete',
        method: 'post',
        success: '202',
        errors: ['400', '401', '404', '409', '410', '422', '429'],
      },
      {
        path: '/videos/{slug}',
        method: 'get',
        success: '200',
        errors: ['401', '404', '429'],
      },
      {
        path: '/videos/{slug}/playback',
        method: 'get',
        success: '200',
        errors: ['401', '404', '409', '429'],
      },
      {
        path: '/videos/{slug}/download',
        method: 'get',
        success: '200',
        errors: ['401', '404', '409', '429'],
      },
    ];

    function operationOf(path: string, method: string) {
      const paths = document.paths as Record<
        string,
        Record<string, Record<string, unknown>>
      >;
      return paths[path]?.[method];
    }

    it('documents exactly the seven video operations', () => {
      const paths = document.paths as Record<string, Record<string, unknown>>;
      const documented = Object.entries(paths)
        .filter(([path]) => path === '/videos' || path.startsWith('/videos/'))
        .flatMap(([path, methods]) =>
          Object.keys(methods).map((method) => `${method} ${path}`),
        )
        .sort();

      expect(documented).toEqual(
        videoOperations.map(({ path, method }) => `${method} ${path}`).sort(),
      );
    });

    it.each(videoOperations)(
      'documents $method $path with security, success and errors',
      ({ path, method, success, errors }) => {
        const operation = operationOf(path, method);
        expect(operation.tags).toEqual(['videos']);
        expect((operation.summary as string).length).toBeGreaterThan(0);
        expect(
          (operation.security as Array<Record<string, unknown>>).some(
            (requirement) => 'access-token' in requirement,
          ),
        ).toBe(true);

        const responses = operation.responses as Record<
          string,
          { content?: Record<string, { schema?: Record<string, unknown> }> }
        >;
        expect(Object.keys(responses).sort()).toEqual(
          [success, ...errors].sort(),
        );
        expect(
          responses[success].content?.['application/json']?.schema?.['$ref'],
        ).toEqual(expect.stringContaining('#/components/schemas/'));
        for (const status of errors) {
          expect(
            responses[status].content?.['application/json']?.schema?.['$ref'],
          ).toBe(apiErrorRef);
        }
      },
    );

    it('declares the nullable fields of the video response', () => {
      const components = document.components as Record<string, unknown>;
      const schemas = components.schemas as Record<
        string,
        { properties: Record<string, Record<string, unknown>> }
      >;
      const { properties } = schemas['VideoResponseDto'];

      for (const field of [
        'sizeBytes',
        'contentType',
        'durationSeconds',
        'width',
        'height',
        'container',
        'videoCodec',
        'audioCodec',
        'thumbnailUrl',
        'failureCode',
      ]) {
        expect(properties[field].nullable).toBe(true);
      }
    });
  });
});
