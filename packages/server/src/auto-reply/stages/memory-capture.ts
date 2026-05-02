// packages/server/src/auto-reply/stages/memory-capture.ts
import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FinClawLogger } from '@finclaw/infra';
import type { EmbeddingProvider } from '@finclaw/storage';
import { addMemory, addMemoryWithEmbedding } from '@finclaw/storage';
import type { MemoryEntry, SessionKey, Timestamp } from '@finclaw/types';
import { createTimestamp } from '@finclaw/types';

/**
 * 명시적 선언 capture 결과.
 * captureNote 부착에 필요한 최소 필드만 노출한다.
 */
export interface MemoryCaptureResult {
  readonly memoryId: string;
  readonly type: 'fact' | 'preference';
  readonly content: string;
  /** 동일 hash 가 이미 저장되어 있던 경우 true. 새 row 는 만들어지지 않음. */
  readonly duplicate: boolean;
}

/**
 * 정규식 5종 — 사용자 결정으로 LLM 자동 추출은 하지 않는다.
 * 우선순위: 위에서 아래로, 첫 매치만 적용.
 */
const PATTERNS: ReadonlyArray<{
  readonly regex: RegExp;
  readonly type: 'fact' | 'preference';
}> = [
  { regex: /^!finclaw\s+remember\s+(.+)/i, type: 'fact' },
  { regex: /^기억해[:\s]\s*(.+)/i, type: 'fact' },
  { regex: /^메모[:\s]\s*(.+)/i, type: 'fact' },
  { regex: /^선호[:\s]\s*(.+)/i, type: 'preference' },
  { regex: /내\s*(?:투자\s*)?(?:기준|원칙|철학)[은는]\s*(.+)/i, type: 'preference' },
];

const MIN_CONTENT_LEN = 3;

/** capture 서비스 인터페이스 — 파이프라인이 의존성으로 받는다. */
export interface MemoryCaptureService {
  capture(text: string, sessionKey: SessionKey): Promise<MemoryCaptureResult | null>;
}

export interface MemoryCaptureServiceDeps {
  readonly db: DatabaseSync;
  readonly embeddingProvider?: EmbeddingProvider;
  readonly logger: FinClawLogger;
}

function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/**
 * 기본 구현.
 *
 * 흐름:
 * 1. 패턴 5종 매치 시도. 첫 매치만 사용.
 * 2. content trim 후 길이 체크 (< 3 → 무시)
 * 3. sha256(content) 로 dedup 검사 → 기존 id 재사용 + duplicate=true
 * 4. embeddingProvider 있으면 addMemoryWithEmbedding, 없으면 addMemory (FTS-only)
 * 5. 임베딩 throw 발생 시 raw addMemory fallback + warn
 */
export class DefaultMemoryCaptureService implements MemoryCaptureService {
  constructor(private readonly deps: MemoryCaptureServiceDeps) {}

  async capture(text: string, sessionKey: SessionKey): Promise<MemoryCaptureResult | null> {
    for (const { regex, type } of PATTERNS) {
      const match = text.match(regex);
      if (!match) {
        continue;
      }

      const content = match[1].trim();
      if (content.length < MIN_CONTENT_LEN) {
        return null;
      }

      const hash = sha256(content);

      // dedup: 기존 hash 존재 시 새 row 만들지 않고 기존 id 반환
      const existing = this.deps.db.prepare('SELECT id FROM memories WHERE hash = ?').get(hash) as
        | { id: string }
        | undefined;

      if (existing) {
        this.deps.logger.info('Memory capture: duplicate skipped', {
          event: 'memory.capture.duplicate',
          memoryId: existing.id,
        });
        return {
          memoryId: existing.id,
          type,
          content,
          duplicate: true,
        };
      }

      const entry: MemoryEntry = {
        id: randomUUID(),
        sessionKey,
        content,
        type,
        createdAt: createTimestamp(Date.now()) as Timestamp,
        metadata: { source: 'auto-reply.capture', pattern: regex.source },
      };

      try {
        if (this.deps.embeddingProvider) {
          await addMemoryWithEmbedding(this.deps.db, entry, this.deps.embeddingProvider);
        } else {
          addMemory(this.deps.db, entry);
        }
      } catch (err) {
        // 임베딩 프로바이더 장애 — raw addMemory fallback (FTS 만 인덱싱)
        this.deps.logger.warn('Memory capture: embedding failed, falling back to FTS-only', {
          event: 'memory.capture.embedding_failed',
          memoryId: entry.id,
          error: err instanceof Error ? err.message : String(err),
        });
        try {
          addMemory(this.deps.db, entry);
        } catch (fallbackErr) {
          this.deps.logger.error('Memory capture: fallback addMemory also failed', {
            event: 'memory.capture.failed',
            memoryId: entry.id,
            error: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
          });
          return null;
        }
      }

      this.deps.logger.info('Memory captured', {
        event: 'memory.capture.success',
        memoryId: entry.id,
        type,
      });

      return {
        memoryId: entry.id,
        type,
        content,
        duplicate: false,
      };
    }

    return null;
  }
}

/**
 * 파이프라인 단계 — capture service 호출 + 예외 격리.
 *
 * capture 실패가 파이프라인을 막아서는 안 된다 (best-effort).
 */
export async function memoryCaptureStage(
  text: string,
  sessionKey: SessionKey,
  service: MemoryCaptureService | undefined,
  logger: FinClawLogger,
): Promise<MemoryCaptureResult | null> {
  if (!service) {
    return null;
  }
  try {
    return await service.capture(text, sessionKey);
  } catch (err) {
    logger.warn('memoryCaptureStage error (suppressed)', {
      event: 'memory.capture.stage_error',
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}
