import {
  Dedupe,
  getEventBus,
  runWithContext,
  type FinClawLogger,
  ConcurrencyLaneManager,
  type LaneId,
} from '@finclaw/infra';
// packages/server/src/process/message-router.ts
import type { InboundMessage, MsgContext, SessionKey } from '@finclaw/types';
import { MessageQueue, type QueueEntry } from './message-queue.js';
import { deriveRoutingSessionKey } from './session-key.js';

export interface MessageRouterDeps {
  logger: FinClawLogger;
  /** 메시지 처리 콜백 */
  onProcess: (ctx: MsgContext) => Promise<void>;
}

/**
 * 메시지 라우팅 오케스트레이터
 *
 * 흐름:
 * 1.   세션 키 도출 (deriveRoutingSessionKey)
 * 1.5  Dedupe 중복 체크 (5초 TTL)
 * 2.   EventBus 이벤트 발행 ('channel:message')
 * 3.   세션별 FIFO 큐 삽입/즉시 처리 결정
 * 4.   동시성 레인 acquire (ConcurrencyLaneManager)
 * 5.   MsgContext 생성 (buildMsgContext)
 * 6.   runWithContext() ALS 래핑 후 처리 콜백 호출 (onProcess)
 */
export class MessageRouter {
  private readonly queue: MessageQueue;
  private readonly laneManager: ConcurrencyLaneManager;
  private readonly dedupe: Dedupe<boolean>;
  private readonly deps: MessageRouterDeps;
  private entryCounter = 0;

  constructor(deps: MessageRouterDeps) {
    this.deps = deps;
    this.queue = new MessageQueue();
    this.laneManager = new ConcurrencyLaneManager();
    this.dedupe = new Dedupe({ ttlMs: 5000 });
  }

  async route(msg: InboundMessage): Promise<void> {
    const { logger } = this.deps;

    // 1. 세션 키 도출
    // NOTE: accountId는 키 생성에 미사용 (deriveRoutingSessionKey 참조). senderId를 전달하나 키에 불포함.
    const sessionKey = deriveRoutingSessionKey({
      channelId: msg.channelId,
      accountId: msg.senderId,
      chatType: msg.chatType,
      chatId: msg.threadId,
    });

    // 1.5 Dedupe 중복 체크
    if (this.dedupe.check(msg.id)) {
      logger.debug(`Duplicate message filtered: ${msg.id}`);
      return;
    }
    void this.dedupe.execute(msg.id, async () => true); // ID 등록

    logger.debug(`Routing message (session: ${sessionKey as string})`);

    // 2. EventBus 이벤트 발행
    getEventBus().emit('channel:message', msg.channelId as string, msg.id);

    // 3. 큐에 삽입
    const entry: QueueEntry = {
      id: `msg-${++this.entryCounter}`,
      message: msg,
      sessionKey,
    };

    if (this.queue.enqueue(entry)) {
      await this.processNext(sessionKey);
    }
  }

  private async processNext(sessionKey: SessionKey): Promise<void> {
    const entry = this.queue.dequeue(sessionKey);
    if (!entry) {
      return;
    }

    this.queue.markProcessing(sessionKey);
    const key = sessionKey as string;

    // 4. 동시성 레인 획득 (main 고정)
    const laneId: LaneId = 'main';
    const handle = await this.laneManager.acquire(laneId, key);

    try {
      // 5. MsgContext 생성
      const ctx = buildMsgContext(entry.message, sessionKey);

      // 6. runWithContext() ALS 래핑 후 처리 콜백 호출
      await runWithContext({ requestId: entry.id, startedAt: Date.now() }, async () => {
        await this.deps.onProcess(ctx);
      });
    } catch (err) {
      this.deps.logger.error(`Message processing failed: ${String(err)}`);
    } finally {
      handle.release();
      if (this.queue.markDone(sessionKey)) {
        void this.processNext(sessionKey);
      }
    }
  }
}

function buildMsgContext(msg: InboundMessage, sessionKey: SessionKey): MsgContext {
  const discordChannelId = msg.metadata?.discordChannelId;
  return {
    body: msg.body,
    bodyForAgent: msg.body,
    rawBody: msg.rawBody ?? msg.body,
    from: msg.senderId,
    senderId: msg.senderId,
    senderName: msg.senderName ?? msg.senderId,
    provider: msg.channelId as string, // NOTE: channelId가 'discord' 등 플랫폼명이므로 현재 동작. 별도 provider 필드 도입 시 변경 필요.
    channelId: msg.channelId,
    chatType: msg.chatType,
    sessionKey,
    accountId: msg.senderId, // NOTE: InboundMessage에 accountId 없음. senderId로 대체.
    chatId: typeof discordChannelId === 'string' ? discordChannelId : undefined,
    media: msg.media,
    timestamp: msg.timestamp,
  };
}
