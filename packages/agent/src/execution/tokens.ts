// packages/agent/src/execution/tokens.ts
import type { TokenUsage } from '@finclaw/types';
import type { StreamEventListener } from './streaming.js';

/**
 * 토큰 카운터
 *
 * - 누적 토큰 사용량 관리
 * - contextWindow 기반 사용률 계산
 * - 80%/95% 임계값 경고 (리스너에 usage_update 이벤트 발행)
 */
export class TokenCounter {
  private usage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };

  private warned80 = false;
  private warned95 = false;

  constructor(private readonly contextWindow: number) {}

  /** 토큰 사용량 누적 */
  add(delta: TokenUsage): void {
    this.usage = {
      inputTokens: this.usage.inputTokens + delta.inputTokens,
      outputTokens: this.usage.outputTokens + delta.outputTokens,
      cacheReadTokens: (this.usage.cacheReadTokens ?? 0) + (delta.cacheReadTokens ?? 0),
      cacheWriteTokens: (this.usage.cacheWriteTokens ?? 0) + (delta.cacheWriteTokens ?? 0),
    };
  }

  /** 컨텍스트 윈도우 사용률 (0.0 ~ 1.0+) */
  usageRatio(): number {
    return this.usage.inputTokens / this.contextWindow;
  }

  /** 컨텍스트 윈도우 잔여 토큰 수 */
  remaining(): number {
    return Math.max(0, this.contextWindow - this.usage.inputTokens);
  }

  /**
   * 80%/95% 임계값 경고
   *
   * 각 임계값은 최초 1회만 발행한다.
   * 리스너에 usage_update 이벤트를 발행하여 상위 레이어(컴팩션 등)에 알린다.
   */
  checkThresholds(listener?: StreamEventListener): void {
    const ratio = this.usageRatio();
    if (!this.warned80 && ratio >= 0.8) {
      this.warned80 = true;
      listener?.({ type: 'usage_update', usage: this.current });
    }
    if (!this.warned95 && ratio >= 0.95) {
      this.warned95 = true;
      listener?.({ type: 'usage_update', usage: this.current });
    }
  }

  /** 현재 누적 사용량 (읽기 전용) */
  get current(): Readonly<TokenUsage> {
    return this.usage;
  }
}
