// packages/server/src/services/news-memorizer.ts
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { FinClawLogger } from '@finclaw/infra';
import type { EmbeddingProvider } from '@finclaw/storage';
import { addMemory, addMemoryWithEmbedding } from '@finclaw/storage';
import { type MemoryEntry, type Timestamp, createSessionKey } from '@finclaw/types';

const SECTION_RE = /^##\s+([A-Z0-9.]{1,12})\s+\((\d{4}-\d{2}-\d{2})\)\s*$/gm;

export interface SymbolSection {
  readonly symbol: string;
  readonly briefDate: string;
  readonly summary: string;
}

/** `## SYMBOL (YYYY-MM-DD)` 헤딩으로 본문을 심볼별 섹션 분할. */
export function parseSymbolSections(output: string): SymbolSection[] {
  const matches = [...output.matchAll(SECTION_RE)];
  const sections: SymbolSection[] = [];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? output.length) : output.length;
    const summary = output.slice(start, end).trim();
    if (summary.length > 0) {
      sections.push({ symbol: m[1], briefDate: m[2], summary });
    }
  }
  return sections;
}

export interface NewsMemorizerDeps {
  readonly db: DatabaseSync;
  readonly embeddingProvider?: EmbeddingProvider;
  readonly logger: FinClawLogger;
  /** memories.session_key — cron 적재용 고정 키. */
  readonly sessionKey?: string;
}

export class NewsMemorizer {
  constructor(private readonly deps: NewsMemorizerDeps) {}

  /** scheduler onRunComplete 에서 호출. output 을 심볼별 financial memory 로 적재. */
  async absorb(args: { agentRunId: string | null; output: string }): Promise<number> {
    const sections = parseSymbolSections(args.output);
    if (sections.length === 0) {
      this.deps.logger.warn('news_memorizer.no_sections', {
        event: 'news_memorizer.no_sections',
        agentRunId: args.agentRunId,
      });
      return 0;
    }
    const sessionKey = createSessionKey(this.deps.sessionKey ?? 'news-brief');
    let stored = 0;
    for (const s of sections) {
      const entry: MemoryEntry = {
        id: randomUUID(),
        sessionKey,
        content: `[${s.briefDate}] ${s.symbol} 뉴스 요약: ${s.summary}`,
        type: 'financial',
        createdAt: Date.now() as Timestamp,
        metadata: {
          kind: 'news-brief',
          symbol: s.symbol,
          briefDate: s.briefDate,
          sourceAgentRunId: args.agentRunId,
        },
      };
      // content sha256 dedup 은 addMemory 가 자동 처리.
      if (this.deps.embeddingProvider) {
        await addMemoryWithEmbedding(this.deps.db, entry, this.deps.embeddingProvider);
      } else {
        addMemory(this.deps.db, entry);
      }
      stored++;
    }
    this.deps.logger.info('news_memorizer.absorbed', {
      event: 'news_memorizer.absorbed',
      agentRunId: args.agentRunId,
      stored,
    });
    return stored;
  }
}
