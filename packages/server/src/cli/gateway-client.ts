// packages/server/src/cli/gateway-client.ts

export interface RpcResult<T> {
  readonly ok: boolean;
  readonly data?: T;
  readonly error?: { code: number; message: string };
}

export interface GatewayClientOptions {
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
}

const DEFAULT_BASE_URL = 'http://127.0.0.1:3000';

export async function getGatewayHealth(
  opts?: GatewayClientOptions,
): Promise<RpcResult<Record<string, unknown>>> {
  const baseUrl = opts?.baseUrl ?? DEFAULT_BASE_URL;
  const timeoutMs = opts?.timeoutMs ?? 5_000;

  try {
    const res = await fetch(`${baseUrl}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      return {
        ok: false,
        error: { code: res.status, message: `HTTP ${res.status}: ${res.statusText}` },
      };
    }
    const data = (await res.json()) as Record<string, unknown>;
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: { code: -1, message: (err as Error).message } };
  }
}

export async function callGateway<T = unknown>(
  method: string,
  params?: Record<string, unknown>,
  opts?: GatewayClientOptions,
): Promise<RpcResult<T>> {
  const baseUrl = opts?.baseUrl ?? DEFAULT_BASE_URL;
  const timeoutMs = opts?.timeoutMs ?? 30_000;

  try {
    const res = await fetch(`${baseUrl}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method,
        params: params ?? {},
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      return {
        ok: false,
        error: { code: res.status, message: `HTTP ${res.status}: ${res.statusText}` },
      };
    }
    const body = (await res.json()) as { result?: T; error?: { code?: number; message: string } };
    if (body.error) {
      return { ok: false, error: { code: body.error.code ?? -32603, message: body.error.message } };
    }
    return { ok: true, data: body.result };
  } catch (err) {
    return { ok: false, error: { code: -1, message: (err as Error).message } };
  }
}
