// packages/skills-finance/src/toss/client.ts
// 토스증권 Open API 클라이언트 — 읽기 전용.
//
// 이 API 에는 읽기 전용 권한이 없다: 같은 토큰으로 실제 주문이 나간다. 그래서 이 파일이 보내는 요청은
// 토큰 발급 POST 1종과 `/api/v1/` 아래 GET 뿐이다. 다른 메서드를 보내는 코드 경로를 만들지 말 것.
// 스펙: https://openapi.tossinvest.com/openapi-docs/latest/openapi.json
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const BASE_URL = 'https://openapi.tossinvest.com';
const REFRESH_MARGIN_MS = 60_000;
const MAX_RETRY_AFTER_MS = 5_000;
/** 경로 조각에 종목코드가 들어간다 (`005930`, `BRK.B`) — 그 밖의 문자와 `..` 는 거부. */
const READ_PATH = /^\/api\/v1\/[A-Za-z0-9._/-]+$/;
/** 토큰이 죽었다는 401 코드. 토큰은 클라이언트당 1개만 유효해, 다른 프로세스가 새로 받으면 내 것이 revoked 된다. */
const DEAD_TOKEN_CODES = new Set(['expired-token', 'token-revoked', 'invalid-token']);

export class TossApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(`toss ${status} ${code}: ${message}`);
    this.name = 'TossApiError';
  }
}

export interface TossClientOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  /** 프로세스 간 토큰 공유 파일. 기본 ~/.finclaw/toss-token.json (0600). */
  readonly tokenPath?: string;
  readonly fetchFn?: typeof fetch;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

export type TossQuery = Readonly<Record<string, string | number | boolean | undefined>>;

interface StoredToken {
  readonly clientId: string;
  readonly accessToken: string;
  readonly expiresAt: number; // unix ms
}

export class TossClient {
  private readonly tokenPath: string;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private token: StoredToken | null = null;
  private issuing: Promise<string> | null = null;
  private account: Promise<number> | null = null;

  constructor(private readonly opts: TossClientOptions) {
    this.tokenPath = opts.tokenPath ?? join(homedir(), '.finclaw', 'toss-token.json');
    this.fetchFn = opts.fetchFn ?? fetch;
    this.now = opts.now ?? Date.now;
    this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * 조회 1건. 응답 envelope 의 `result` 를 돌려준다.
   * `account: true` 면 계좌 헤더(`X-Tossinvest-Account`)를 붙인다 — 계좌·자산·주문 조회용.
   */
  async get<T>(path: string, query: TossQuery = {}, opts: { account?: boolean } = {}): Promise<T> {
    if (!READ_PATH.test(path) || path.includes('..')) {
      throw new Error(`toss: path not allowed: ${path}`);
    }
    const url = new URL(path, BASE_URL);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) {
        url.searchParams.set(key, String(value));
      }
    }
    const accountSeq = opts.account ? await this.accountSeq() : undefined;
    let res = await this.send(url, await this.accessToken(), accountSeq);
    if (res.status === 401 && DEAD_TOKEN_CODES.has((await peekError(res)).code)) {
      res = await this.send(url, await this.accessToken(this.token?.accessToken), accountSeq);
    } else if (res.status === 429) {
      const retryAfterMs = Number(res.headers.get('retry-after') ?? '1') * 1000;
      await this.sleep(Math.min(Math.max(retryAfterMs, 0), MAX_RETRY_AFTER_MS));
      res = await this.send(url, await this.accessToken(), accountSeq);
    }
    if (!res.ok) {
      const error = await peekError(res);
      throw new TossApiError(res.status, error.code, error.message);
    }
    return ((await res.json()) as { result: T }).result;
  }

  /** ponytail: 첫 계좌 고정. 계좌가 여러 개가 되면 TOSS_ACCOUNT_SEQ 선택을 추가. */
  accountSeq(): Promise<number> {
    this.account ??= this.get<readonly { accountSeq: number }[]>('/api/v1/accounts').then(
      (accounts) => {
        const first = accounts[0];
        if (!first) {
          throw new Error('toss: no account');
        }
        return first.accountSeq;
      },
    );
    this.account.catch(() => {
      this.account = null; // 실패는 캐시하지 않는다
    });
    return this.account;
  }

  private send(url: URL, token: string, accountSeq?: number): Promise<Response> {
    return this.fetchFn(url, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${token}`,
        ...(accountSeq === undefined ? {} : { 'x-tossinvest-account': String(accountSeq) }),
      },
    });
  }

  /** 유효 토큰. `dead` 를 주면 그 토큰은 버린다. 순서: 메모리 → 공유 파일 → 새 발급(직전 토큰은 즉시 무효). */
  private async accessToken(dead?: string): Promise<string> {
    const usable = (t: StoredToken | null): t is StoredToken =>
      t !== null &&
      t.clientId === this.opts.clientId &&
      t.accessToken !== dead &&
      t.expiresAt - REFRESH_MARGIN_MS > this.now();
    if (usable(this.token)) {
      return this.token.accessToken;
    }
    const shared = this.readShared();
    if (usable(shared)) {
      this.token = shared;
      return shared.accessToken;
    }
    this.issuing ??= this.issue().finally(() => {
      this.issuing = null;
    });
    return this.issuing;
  }

  private async issue(): Promise<string> {
    const res = await this.fetchFn(new URL('/oauth2/token', BASE_URL), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.opts.clientId,
        client_secret: this.opts.clientSecret,
      }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        error_description?: string;
      };
      throw new TossApiError(
        res.status,
        body.error ?? 'token-issue-failed',
        body.error_description ?? 'token issue failed',
      );
    }
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.token = {
      clientId: this.opts.clientId,
      accessToken: body.access_token,
      expiresAt: this.now() + body.expires_in * 1000,
    };
    try {
      mkdirSync(dirname(this.tokenPath), { recursive: true });
      writeFileSync(this.tokenPath, JSON.stringify(this.token), { mode: 0o600 });
    } catch {
      // 공유 파일을 못 써도 이 프로세스는 메모리 토큰으로 동작한다
    }
    return this.token.accessToken;
  }

  private readShared(): StoredToken | null {
    try {
      return JSON.parse(readFileSync(this.tokenPath, 'utf8')) as StoredToken;
    } catch {
      return null;
    }
  }
}

/** 에러 envelope `{error:{code,message}}` 를 응답을 소모하지 않고 읽는다. */
async function peekError(res: Response): Promise<{ code: string; message: string }> {
  const body = (await res
    .clone()
    .json()
    .catch(() => ({}))) as { error?: { code?: string; message?: string } };
  return { code: body.error?.code ?? 'unknown', message: body.error?.message ?? res.statusText };
}
