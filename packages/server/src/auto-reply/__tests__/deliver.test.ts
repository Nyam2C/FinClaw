import type { FinClawLogger } from '@finclaw/infra';
import { createTimestamp, createSessionKey, createChannelId } from '@finclaw/types';
import { describe, it, expect, vi } from 'vitest';
import type { PipelineMsgContext } from '../pipeline-context.js';
import type { ExecuteStageResult } from '../stages/execute.js';
import { deliverResponse } from '../stages/deliver.js';

function makeLogger(): FinClawLogger {
  return {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn().mockReturnThis(),
    flush: vi.fn().mockResolvedValue(undefined),
  } as unknown as FinClawLogger;
}

function makePipelineCtx(overrides: Partial<PipelineMsgContext> = {}): PipelineMsgContext {
  return {
    body: 'test',
    bodyForAgent: 'test',
    rawBody: 'test',
    from: 'user1',
    senderId: 'user1',
    senderName: 'User',
    provider: 'discord',
    channelId: createChannelId('discord'),
    chatType: 'direct',
    sessionKey: createSessionKey('test'),
    accountId: 'user1',
    timestamp: createTimestamp(Date.now()),
    normalizedBody: 'test',
    mentions: [],
    urls: [],
    channelCapabilities: {
      supportsMarkdown: true,
      supportsImages: false,
      supportsAudio: false,
      supportsVideo: false,
      supportsButtons: false,
      supportsThreads: false,
      supportsReactions: false,
      supportsEditing: false,
      maxMessageLength: 2000,
    },
    userRoles: [],
    isAdmin: false,
    ...overrides,
  };
}

function makeExecResult(overrides: Partial<ExecuteStageResult> = {}): ExecuteStageResult {
  return {
    content: 'Hello, this is a response.',
    controlTokens: {
      cleanContent: 'Hello, this is a response.',
      tokens: [],
      hasNoReply: false,
      hasSilentReply: false,
      hasHeartbeat: false,
      needsDisclaimer: false,
      needsQuote: false,
    },
    ...overrides,
  };
}

describe('deliverResponse', () => {
  it('일반 응답을 전송한다', async () => {
    const channel = { send: vi.fn().mockResolvedValue(undefined) };
    const logger = makeLogger();
    const ctx = makePipelineCtx();

    const result = await deliverResponse(makeExecResult(), ctx, channel, logger);

    expect(result.action).toBe('continue');
    expect(channel.send).toHaveBeenCalledTimes(1);
  });

  it('SILENT_REPLY 시 skip을 반환한다', async () => {
    const channel = { send: vi.fn() };
    const logger = makeLogger();
    const execResult = makeExecResult({
      controlTokens: {
        cleanContent: 'test',
        tokens: [],
        hasNoReply: false,
        hasSilentReply: true,
        hasHeartbeat: false,
        needsDisclaimer: false,
        needsQuote: false,
      },
    });

    const result = await deliverResponse(execResult, makePipelineCtx(), channel, logger);

    expect(result.action).toBe('skip');
    expect(channel.send).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalled();
  });

  it('면책 조항을 첨부한다', async () => {
    const channel = { send: vi.fn().mockResolvedValue(undefined) };
    const logger = makeLogger();
    const execResult = makeExecResult({
      controlTokens: {
        cleanContent: 'AAPL analysis',
        tokens: [],
        hasNoReply: false,
        hasSilentReply: false,
        hasHeartbeat: false,
        needsDisclaimer: true,
        needsQuote: false,
      },
    });

    const result = await deliverResponse(execResult, makePipelineCtx(), channel, logger);

    expect(result.action).toBe('continue');
    if (result.action !== 'continue') {
      return;
    }
    const text = result.data.payloads[0]?.text;
    expect(text).toContain('투자 조언이 아니며');
  });

  it('긴 메시지를 분할 전송한다', async () => {
    const channel = { send: vi.fn().mockResolvedValue(undefined) };
    const logger = makeLogger();
    const longContent = 'A'.repeat(3000);
    const execResult = makeExecResult({ content: longContent });
    const ctx = makePipelineCtx();

    const result = await deliverResponse(execResult, ctx, channel, logger);

    expect(result.action).toBe('continue');
    expect(channel.send).toHaveBeenCalledTimes(2);
  });

  it('개별 전송 실패 시 나머지 파트는 계속 전송한다', async () => {
    const channel = {
      send: vi.fn().mockRejectedValueOnce(new Error('send failed')).mockResolvedValue(undefined),
    };
    const logger = makeLogger();
    const longContent = 'A'.repeat(3000);
    const execResult = makeExecResult({ content: longContent });

    const result = await deliverResponse(execResult, makePipelineCtx(), channel, logger);

    expect(result.action).toBe('continue');
    expect(channel.send).toHaveBeenCalledTimes(2);
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('send가 없는 채널에서도 정상 동작한다', async () => {
    const channel = { send: undefined };
    const logger = makeLogger();

    const result = await deliverResponse(makeExecResult(), makePipelineCtx(), channel, logger);

    expect(result.action).toBe('continue');
  });
});
