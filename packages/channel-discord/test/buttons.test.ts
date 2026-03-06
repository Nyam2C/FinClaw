import type { Client } from 'discord.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ApprovalButtonData } from '../src/types.js';
import {
  buildApprovalRow,
  waitForApproval,
  setupApprovalHandler,
  _resetPendingApprovals,
} from '../src/buttons.js';

// discord.js mock
vi.mock('discord.js', () => {
  class ButtonBuilder {
    private _data: Record<string, unknown> = {};
    setCustomId(id: string) {
      this._data.customId = id;
      return this;
    }
    setLabel(label: string) {
      this._data.label = label;
      return this;
    }
    setStyle(style: number) {
      this._data.style = style;
      return this;
    }
    get data() {
      return this._data;
    }
  }

  class ActionRowBuilder<T = unknown> {
    private _components: T[] = [];
    addComponents(...components: T[]) {
      this._components.push(...components);
      return this;
    }
    get components() {
      return this._components;
    }
  }

  return {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle: { Success: 3, Danger: 4 },
    MessageFlags: { Ephemeral: 64 },
  };
});

// @finclaw/infra mock
vi.mock('@finclaw/infra', () => ({
  createLogger: () => ({
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
    flush: vi.fn(),
  }),
}));

function makeApprovalData(overrides: Partial<ApprovalButtonData> = {}): ApprovalButtonData {
  return {
    toolCallId: 'tool-123',
    toolName: 'search',
    toolInput: '{}',
    sessionId: 'sess-1',
    userId: 'user-1',
    ...overrides,
  };
}

describe('buildApprovalRow', () => {
  it('승인/거부 버튼 2개를 포함하는 ActionRow를 생성한다', () => {
    const row = buildApprovalRow(makeApprovalData());
    expect(row.components).toHaveLength(2);
  });

  it('버튼의 customId에 toolCallId를 포함한다', () => {
    const row = buildApprovalRow(makeApprovalData({ toolCallId: 'tc-abc' }));
    const customIds = row.components.map(
      (b: unknown) => (b as { data: { customId: string } }).data.customId,
    );
    expect(customIds).toContain('approve:tc-abc');
    expect(customIds).toContain('deny:tc-abc');
  });
});

describe('waitForApproval', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetPendingApprovals();
  });

  afterEach(() => {
    _resetPendingApprovals();
    vi.useRealTimers();
  });

  it('타임아웃 시 false를 반환한다', async () => {
    const promise = waitForApproval('tc-1', 5000);
    vi.advanceTimersByTime(5000);
    const result = await promise;
    expect(result).toBe(false);
  });

  it('타임아웃 전에는 resolve되지 않는다', () => {
    const promise = waitForApproval('tc-2', 10000);
    vi.advanceTimersByTime(5000);
    // Promise는 아직 pending 상태
    let resolved = false;
    void promise.then(() => {
      resolved = true;
    });
    expect(resolved).toBe(false);
  });
});

describe('setupApprovalHandler', () => {
  function makeClient() {
    const listeners: Record<string, ((...args: unknown[]) => Promise<void>)[]> = {};
    return {
      on(event: string, handler: (...args: unknown[]) => Promise<void>) {
        listeners[event] = listeners[event] ?? [];
        listeners[event].push(handler);
      },
      emit(event: string, ...args: unknown[]) {
        for (const handler of listeners[event] ?? []) {
          void handler(...args);
        }
      },
      _listeners: listeners,
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    _resetPendingApprovals();
  });

  afterEach(() => {
    _resetPendingApprovals();
    vi.useRealTimers();
  });

  it('approve 버튼 클릭 시 true로 resolve한다', async () => {
    const client = makeClient();
    setupApprovalHandler(client as unknown as Client);

    const promise = waitForApproval('tc-approve', 30000);

    const interaction = {
      isButton: () => true,
      customId: 'approve:tc-approve',
      reply: vi.fn(),
      update: vi.fn(),
    };

    client.emit('interactionCreate', interaction);
    // flush microtasks
    await vi.advanceTimersByTimeAsync(0);

    const result = await promise;
    expect(result).toBe(true);
    expect(interaction.update).toHaveBeenCalledWith(
      expect.objectContaining({ content: '도구 실행이 승인되었습니다.' }),
    );
  });

  it('deny 버튼 클릭 시 false로 resolve한다', async () => {
    const client = makeClient();
    setupApprovalHandler(client as unknown as Client);

    const promise = waitForApproval('tc-deny', 30000);

    const interaction = {
      isButton: () => true,
      customId: 'deny:tc-deny',
      reply: vi.fn(),
      update: vi.fn(),
    };

    client.emit('interactionCreate', interaction);
    await vi.advanceTimersByTimeAsync(0);

    const result = await promise;
    expect(result).toBe(false);
    expect(interaction.update).toHaveBeenCalledWith(
      expect.objectContaining({ content: '도구 실행이 거부되었습니다.' }),
    );
  });

  it('만료된 toolCallId에 대해 ephemeral 응답을 보낸다', async () => {
    const client = makeClient();
    setupApprovalHandler(client as unknown as Client);

    // pending이 없는 상태에서 버튼 클릭
    const interaction = {
      isButton: () => true,
      customId: 'approve:nonexistent',
      reply: vi.fn(),
      update: vi.fn(),
    };

    client.emit('interactionCreate', interaction);
    await vi.advanceTimersByTimeAsync(0);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({ content: '이 요청은 이미 만료되었습니다.' }),
    );
  });

  it('버튼이 아닌 인터랙션은 무시한다', async () => {
    const client = makeClient();
    setupApprovalHandler(client as unknown as Client);

    const interaction = {
      isButton: () => false,
      customId: 'approve:tc-x',
      reply: vi.fn(),
      update: vi.fn(),
    };

    client.emit('interactionCreate', interaction);
    await vi.advanceTimersByTimeAsync(0);

    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.update).not.toHaveBeenCalled();
  });
});
