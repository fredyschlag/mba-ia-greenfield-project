import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { cleanAllTables } from '../src/test/create-test-data-source';
import {
  createVideoE2eContext,
  E2E_TIMEOUT_MS,
  registerConfirmAndLogin,
  type TestUser,
  type VideoE2eContext,
} from './support/video-e2e';

const UNKNOWN_ID = '99999999-9999-4999-8999-999999999999';
const UNKNOWN_SLUG = 'aZ3kP9xQ1bC';
const CREATE_LIMIT = 10;
const PUBLIC_AUTH_LIMIT = 10;
const TOO_MANY_REQUESTS_BODY = {
  statusCode: 429,
  error: 'TOO_MANY_REQUESTS',
  message: 'ThrottlerException: Too Many Requests',
};

interface VideoRoute {
  name: string;
  method: 'get' | 'post';
  path: string;
  limit: number;
  // Rejected after the guards, so no video or storage object is created.
  status: number;
}

const VIDEO_ROUTES: VideoRoute[] = [
  {
    name: 'POST /videos',
    method: 'post',
    path: '/videos',
    limit: 10,
    status: 400,
  },
  {
    name: 'POST /videos/:id/upload/part-urls',
    method: 'post',
    path: `/videos/${UNKNOWN_ID}/upload/part-urls`,
    limit: 60,
    status: 400,
  },
  {
    name: 'GET /videos/:id/upload/parts',
    method: 'get',
    path: `/videos/${UNKNOWN_ID}/upload/parts`,
    limit: 30,
    status: 404,
  },
  {
    name: 'POST /videos/:id/upload/complete',
    method: 'post',
    path: `/videos/${UNKNOWN_ID}/upload/complete`,
    limit: 10,
    status: 400,
  },
  {
    name: 'GET /videos/:slug',
    method: 'get',
    path: `/videos/${UNKNOWN_SLUG}`,
    limit: 120,
    status: 404,
  },
  {
    name: 'GET /videos/:slug/playback',
    method: 'get',
    path: `/videos/${UNKNOWN_SLUG}/playback`,
    limit: 30,
    status: 404,
  },
  {
    name: 'GET /videos/:slug/download',
    method: 'get',
    path: `/videos/${UNKNOWN_SLUG}/download`,
    limit: 10,
    status: 404,
  },
];

const CREATE_ROUTE = VIDEO_ROUTES[0];

describe('Video rate limits (e2e)', () => {
  let context: VideoE2eContext;
  let userA: TestUser;
  let userB: TestUser;

  function call(route: VideoRoute, token?: string): request.Test {
    const server = context.app.getHttpServer();
    const pending =
      route.method === 'post'
        ? request(server).post(route.path).send({})
        : request(server).get(route.path);
    return token ? pending.set('Authorization', `Bearer ${token}`) : pending;
  }

  async function exhaust(
    route: VideoRoute,
    token: string,
  ): Promise<request.Response> {
    for (let attempt = 0; attempt < route.limit; attempt += 1) {
      await call(route, token).expect(route.status);
    }
    return call(route, token).expect(429);
  }

  beforeAll(async () => {
    context = await createVideoE2eContext();
  }, E2E_TIMEOUT_MS);

  afterAll(async () => {
    await context.app.close();
  }, E2E_TIMEOUT_MS);

  beforeEach(async () => {
    context.throttlerStorage.storage.clear();
    await cleanAllTables(context.dataSource);
    userA = await registerConfirmAndLogin(
      context,
      `throttle_a_${randomUUID()}@example.com`,
    );
    userB = await registerConfirmAndLogin(
      context,
      `throttle_b_${randomUUID()}@example.com`,
    );
  }, E2E_TIMEOUT_MS);

  it.each(VIDEO_ROUTES)(
    'should answer 401 without a token on $name',
    async (route) => {
      await call(route).expect(401);
      await call(route, 'malformed-token').expect(401);
    },
    E2E_TIMEOUT_MS,
  );

  it(
    'should not consume the user counter on calls without a token',
    async () => {
      for (let attempt = 0; attempt < CREATE_LIMIT + 5; attempt += 1) {
        await call(CREATE_ROUTE).expect(401);
      }

      await exhaust(CREATE_ROUTE, userA.token);
    },
    E2E_TIMEOUT_MS,
  );

  it(
    'should keep answering 401 after the user reaches the limit',
    async () => {
      await exhaust(CREATE_ROUTE, userA.token);

      await call(CREATE_ROUTE).expect(401);
    },
    E2E_TIMEOUT_MS,
  );

  it.each(VIDEO_ROUTES)(
    'should limit $name to $limit calls per user',
    async (route) => {
      await exhaust(route, userA.token);
    },
    E2E_TIMEOUT_MS,
  );

  it(
    'should answer 429 with the error envelope on a video route',
    async () => {
      const response = await exhaust(CREATE_ROUTE, userA.token);

      expect(response.body).toEqual(TOO_MANY_REQUESTS_BODY);
      expect(response.headers['retry-after']).toBeDefined();
    },
    E2E_TIMEOUT_MS,
  );

  it(
    'should not affect a second user on the same IP',
    async () => {
      await exhaust(CREATE_ROUTE, userA.token);

      await call(CREATE_ROUTE, userB.token).expect(CREATE_ROUTE.status);
    },
    E2E_TIMEOUT_MS,
  );

  it(
    'should not block another video route of the same user',
    async () => {
      await exhaust(CREATE_ROUTE, userA.token);

      for (const route of VIDEO_ROUTES.slice(1)) {
        await call(route, userA.token).expect(route.status);
      }
    },
    E2E_TIMEOUT_MS,
  );

  it(
    'should keep the IP limit on a public auth route',
    async () => {
      const server = context.app.getHttpServer();

      for (let attempt = 0; attempt < PUBLIC_AUTH_LIMIT; attempt += 1) {
        await request(server).post('/auth/login').send({}).expect(400);
      }

      const response = await request(server)
        .post('/auth/login')
        .send({})
        .expect(429);

      expect(response.body).toEqual(TOO_MANY_REQUESTS_BODY);
      expect(response.headers['retry-after']).toBeDefined();
    },
    E2E_TIMEOUT_MS,
  );
});
