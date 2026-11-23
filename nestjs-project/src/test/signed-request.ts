import { type IncomingHttpHeaders, request } from 'node:http';

export interface SignedRequestOptions {
  method?: string;
  body?: Buffer;
  headers?: Record<string, string>;
}

export interface SignedResponse {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

/**
 * Calls a presigned URL from inside a container: connects to the MinIO service
 * while preserving the public Host header that was signed.
 */
export function signedRequest(
  url: string,
  options: SignedRequestOptions = {},
): Promise<SignedResponse> {
  const { method = 'GET', body, headers = {} } = options;
  const parsed = new URL(url);

  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        hostname: 'minio',
        port: 9000,
        method,
        path: `${parsed.pathname}${parsed.search}`,
        headers: {
          Host: parsed.host,
          ...(body ? { 'Content-Length': String(body.length) } : {}),
          ...headers,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('error', reject);
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );
    outgoing.on('error', reject);
    outgoing.end(body);
  });
}
