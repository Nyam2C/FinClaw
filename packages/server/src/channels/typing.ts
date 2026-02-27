// packages/server/src/channels/typing.ts
import type { ChannelPlugin } from '@finclaw/types';

const DEFAULT_INTERVAL_MS = 5_000;

export interface TypingHandle {
  stop(): void;
}

/**
 * 타이핑 인디케이터를 주기적으로 전송.
 * `sendTyping`이 없는 채널은 no-op 핸들을 반환.
 */
export function startTyping(
  channel: Pick<ChannelPlugin, 'sendTyping'>,
  channelId: string,
  chatId: string,
  intervalMs: number = DEFAULT_INTERVAL_MS,
): TypingHandle {
  if (!channel.sendTyping) {
    return { stop() {} };
  }

  const send = channel.sendTyping.bind(channel);

  // TODO(review): void send() — unhandled rejection 위험. stopAllTyping/shutdown 정리 메커니즘 부재.
  // 에러 핸들링 래퍼 + 전역 타이머 추적 맵 도입 검토.
  // 즉시 1회 전송
  void send(channelId, chatId);

  const timer = setInterval(() => {
    void send(channelId, chatId);
  }, intervalMs);

  return {
    stop() {
      clearInterval(timer);
    },
  };
}
