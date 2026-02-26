// packages/server/src/process/message-router.ts
import type { InboundMessage, MsgContext, SessionKey, AgentId } from '@finclaw/types';
import type { FinClawConfig } from '@finclaw/types';
import {
  Dedupe,
  getEventBus,
  runWithContext,
  type FinClawLogger,
  ConcurrencyLaneManager,
  type LaneId,
} from '@finclaw/infra';
import { createTimestamp } from '@finclaw/types';
import { matchBinding, extractBindingRules, type BindingMatch } from './binding-matcher.js';
import { MessageQueue, type QueueEntry } from './message-queue.js';
import { deriveRoutingSessionKey } from './session-key.js';

export interface MessageRouterDeps {
  config: FinClawConfig;
  logger: FinClawLogger;
  /** 메시지 처리 콜백 — AbortSignal로 interrupt 모드 지원 */
  onProcess: (ctx: MsgContext, match: BindingMatch, signal: AbortSignal) => Promise<void>;
}

/**
 * 메시지 라우팅 오케스트레이터
 *
 * 흐름:
 * 1.   세션 키 도출 (deriveRoutingSessionKey)
 * 1.5  Dedupe 중복 체크 (5초 TTL)
 * 2.   바인딩 매칭 (matchBinding — 4계층)
 * 3.   메시지 큐 삽입/즉시 처리 결정
 * 4.   동시성 레인 acquire (ConcurrencyLaneManager)
 * 5.   MsgContext 생성 (buildMsgContext)
 * 5.5  AbortController 생성 → activeControllers Map
 * 6.   EventBus 이벤트 발행 ('channel:message')
 * 6.5  runWithContext() ALS 래핑
 * 7.   처리 콜백 호출 (onProcess)
 */
export class MessageRouter {
  private readonly queue: MessageQueue;
  private readonly laneManager: ConcurrencyLaneManager;
  private readonly dedupe: Dedupe<boolean>;
  /** interrupt 모드: 세션별 활성 AbortController */
  private readonly activeControllers = new Map<string, AbortController>();
  private readonly deps: MessageRouterDeps;
  private entryCounter = 0;

  constructor(deps: MessageRouterDeps) {
    this.deps = deps;
    this.queue = new MessageQueue({ mode: 'queue', maxSize: 50 });
    this.laneManager = new ConcurrencyLaneManager();
    this.dedupe = new Dedupe({ ttlMs: 5000 });
  }

  async route(msg: InboundMessage): Promise<void> {
    const { logger, config } = this.deps;

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

    // 2. 바인딩 매칭
    const rules = extractBindingRules(config);
    const defaultAgentId = getDefaultAgentId(config);
    const match = matchBinding(msg, rules, defaultAgentId);

    logger.debug(
      `Routing message to agent ${match.agentId as string} ` +
        `(match: ${match.matchTier}, session: ${sessionKey as string})`,
    );

    // 6. EventBus 이벤트 발행
    getEventBus().emit('channel:message', msg.channelId as string, msg.id);

    // 3. 큐에 삽입
    const entry: QueueEntry = {
      id: `msg-${++this.entryCounter}`,
      message: msg,
      sessionKey,
      enqueuedAt: createTimestamp(Date.now()),
      priority: 0,
    };

    const enqueueResult = this.queue.enqueue(entry);

    // interrupt 모드: 기존 처리 취소
    if (enqueueResult === 'interrupt') {
      const key = sessionKey as string;
      const existing = this.activeControllers.get(key);
      if (existing) {
        existing.abort();
        this.activeControllers.delete(key);
      }
    }

    if (enqueueResult === true || enqueueResult === 'interrupt') {
      await this.processNext(sessionKey, match);
    }
  }

  private async processNext(sessionKey: SessionKey, match: BindingMatch): Promise<void> {
    const entry = this.queue.dequeue(sessionKey);
    if (!entry) {
      return;
    }

    this.queue.markProcessing(sessionKey);
    const key = sessionKey as string;

    // 4. 동시성 레인 획득
    // TODO(Phase 8): laneId를 BindingMatch 또는 config에서 도출. 현재 main 고정.
    const laneId: LaneId = 'main';
    const handle = await this.laneManager.acquire(laneId, key);

    // 5.5 AbortController 생성
    const controller = new AbortController();
    this.activeControllers.set(key, controller);

    try {
      // 5. MsgContext 생성
      const ctx = buildMsgContext(entry.message, sessionKey, match);

      // 6.5 runWithContext() ALS 래핑
      await runWithContext({ requestId: entry.id, startedAt: Date.now() }, async () => {
        // 7. 처리 콜백 호출
        await this.deps.onProcess(ctx, match, controller.signal);
      });
    } catch (err) {
      this.deps.logger.error(`Message processing failed: ${String(err)}`);
    } finally {
      this.activeControllers.delete(key);
      handle.release();
      const hasMore = this.queue.markDone(sessionKey);
      if (hasMore) {
        // NOTE: 이전 match를 재사용. 같은 세션 내 메시지는 동일 바인딩을 가정.
        void this.processNext(sessionKey, match);
      }
    }
  }

  /** 리소스 정리 */
  dispose(): void {
    for (const controller of this.activeControllers.values()) {
      controller.abort();
    }
    this.activeControllers.clear();
    this.laneManager.dispose();
    this.dedupe.clear();
  }
}

function buildMsgContext(
  msg: InboundMessage,
  sessionKey: SessionKey,
  _match: BindingMatch,
): MsgContext {
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
    media: msg.media,
    timestamp: msg.timestamp,
  };
}

function getDefaultAgentId(config: FinClawConfig): AgentId {
  const entries = config.agents?.entries ?? {};
  const firstAgent = Object.keys(entries)[0];
  return (firstAgent ?? 'default') as AgentId;
}
