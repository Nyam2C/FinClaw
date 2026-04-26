import type { FinClawLogger } from '@finclaw/infra';
// packages/server/src/auto-reply/stages/ack.ts
import type { ChannelPlugin } from '@finclaw/types';
// startTyping: 외부 모듈 의존성. 타입체크 통과, 런타임 동작은 통합 테스트 범위.
import { startTyping, type TypingHandle } from '../../channels/typing.js';
import type { StageResult } from '../pipeline.js';

type TypingState = 'idle' | 'active' | 'sealed';

/** 3-상태 타이핑 컨트롤러 */
export interface TypingController {
  start(): void;
  seal(): void;
  readonly state: TypingState;
}

/**
 * TypingController 생성
 *
 * active → processing → sealed
 * - active: 타이핑 인디케이터 표시 중
 * - sealed: 파이프라인 완료 후 재시작 방지
 */
export function createTypingController(
  channel: Pick<ChannelPlugin, 'sendTyping'>,
  channelId: string,
  chatId: string,
  options: { intervalMs?: number; ttlMs?: number } = {},
): TypingController {
  const { intervalMs = 5000, ttlMs = 120_000 } = options;
  let state: TypingState = 'idle';
  let handle: TypingHandle | undefined;
  let ttlTimer: ReturnType<typeof setTimeout> | undefined;

  return {
    get state() {
      return state;
    },
    start() {
      if (state !== 'idle') {
        return;
      }
      state = 'active';
      handle = startTyping(channel, channelId, chatId, intervalMs);

      // TTL 보호: 최대 시간 후 자동 seal
      ttlTimer = setTimeout(() => {
        if (state === 'active') {
          handle?.stop();
          state = 'sealed';
        }
      }, ttlMs);
    },
    seal() {
      if (state === 'sealed') {
        return;
      }
      state = 'sealed';
      handle?.stop();
      if (ttlTimer) {
        clearTimeout(ttlTimer);
      }
    },
  };
}

export interface AckResult {
  readonly typing: TypingController;
}

/**
 * ACK 스테이지
 *
 * 1. addReaction으로 수신 확인 (👀)
 * 2. TypingController 시작
 */
export async function ackStage(
  channel: Pick<ChannelPlugin, 'addReaction' | 'sendTyping'>,
  messageId: string,
  channelId: string,
  chatId: string,
  enableAck: boolean,
  logger: FinClawLogger,
): Promise<StageResult<AckResult>> {
  // ACK 리액션
  if (enableAck && channel.addReaction) {
    try {
      await channel.addReaction(messageId, '👀');
    } catch (error) {
      logger.warn('Failed to add ACK reaction', { error });
    }
  }

  // 타이핑 시작
  const typing = createTypingController(channel, channelId, chatId);
  typing.start();

  return { action: 'continue', data: { typing } };
}
