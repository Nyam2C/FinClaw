import type { MarketQuote, Timestamp, TickerSymbol } from '@finclaw/types';
import type { ChatInputCommandInteraction } from 'discord.js';
import { describe, it, expect, vi } from 'vitest';
import type { CommandDeps, FinanceServicePort } from '../../src/types.js';
import { marketCommand } from '../../src/commands/market.js';

// discord.js mock
vi.mock('discord.js', () => {
  class SlashCommandBuilder {
    private _data: Record<string, unknown> = { name: '', description: '' };
    setName(name: string) {
      this._data.name = name;
      return this;
    }
    setDescription(desc: string) {
      this._data.description = desc;
      return this;
    }
    addStringOption(fn: (opt: unknown) => unknown) {
      fn({
        setName: (_n: string) => ({
          setDescription: (_d: string) => ({ setRequired: (_r: boolean) => ({}) }),
        }),
      });
      return this;
    }
    get name() {
      return this._data.name;
    }
    toJSON() {
      return this._data;
    }
  }

  class EmbedBuilder {
    data: Record<string, unknown> = {};
    setTitle(t: string) {
      this.data.title = t;
      return this;
    }
    setColor(c: number) {
      this.data.color = c;
      return this;
    }
    setFooter(f: Record<string, string>) {
      this.data.footer = f;
      return this;
    }
    setTimestamp() {
      return this;
    }
    setURL(u: string) {
      this.data.url = u;
      return this;
    }
    setDescription(d: string) {
      this.data.description = d;
      return this;
    }
    addFields(...fields: unknown[]) {
      this.data.fields = [...((this.data.fields as unknown[]) ?? []), ...fields];
      return this;
    }
  }

  return {
    SlashCommandBuilder,
    EmbedBuilder,
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

function makeQuote(overrides: Partial<MarketQuote> = {}): MarketQuote {
  return {
    symbol: 'AAPL' as TickerSymbol,
    price: 195.5,
    change: 3.25,
    changePercent: 1.69,
    volume: 54_000_000,
    high: 196.0,
    low: 192.0,
    open: 193.0,
    previousClose: 192.25,
    timestamp: 1708700000000 as Timestamp,
    ...overrides,
  };
}

function makeInteraction(overrides: Record<string, unknown> = {}) {
  return {
    options: {
      getString: vi.fn().mockReturnValue('AAPL'),
    },
    reply: vi.fn().mockResolvedValue(undefined),
    deferReply: vi.fn().mockResolvedValue(undefined),
    editReply: vi.fn().mockResolvedValue(undefined),
    followUp: vi.fn().mockResolvedValue(undefined),
    replied: false,
    deferred: false,
    ...overrides,
  };
}

describe('marketCommand', () => {
  it('financeService가 없으면 "준비 중" ephemeral 응답을 보낸다', async () => {
    const interaction = makeInteraction();
    const deps: CommandDeps = {};

    await marketCommand.execute(interaction as unknown as ChatInputCommandInteraction, deps);

    expect(interaction.reply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: '시세 조회 기능은 아직 준비 중입니다.',
        flags: 64,
      }),
    );
    expect(interaction.deferReply).not.toHaveBeenCalled();
  });

  it('financeService가 있으면 deferReply 후 임베드를 전송한다', async () => {
    const interaction = makeInteraction();
    const financeService: FinanceServicePort = {
      getQuote: vi.fn().mockResolvedValue(makeQuote()),
      searchNews: vi.fn(),
    };
    const deps: CommandDeps = { financeService };

    await marketCommand.execute(interaction as unknown as ChatInputCommandInteraction, deps);

    expect(interaction.deferReply).toHaveBeenCalled();
    expect(financeService.getQuote).toHaveBeenCalledWith('AAPL');
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ embeds: expect.any(Array) }),
    );
  });

  it('getQuote 에러 시 에러 메시지를 editReply로 전송한다', async () => {
    const interaction = makeInteraction();
    const financeService: FinanceServicePort = {
      getQuote: vi.fn().mockRejectedValue(new Error('API down')),
      searchNews: vi.fn(),
    };
    const deps: CommandDeps = { financeService };

    await marketCommand.execute(interaction as unknown as ChatInputCommandInteraction, deps);

    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('API down') }),
    );
  });

  it('ticker 옵션을 올바르게 읽는다', async () => {
    const getString = vi.fn().mockReturnValue('BTC-USD');
    const interaction = makeInteraction({ options: { getString } });
    const financeService: FinanceServicePort = {
      getQuote: vi.fn().mockResolvedValue(makeQuote({ symbol: 'BTC-USD' as TickerSymbol })),
      searchNews: vi.fn(),
    };
    const deps: CommandDeps = { financeService };

    await marketCommand.execute(interaction as unknown as ChatInputCommandInteraction, deps);

    expect(financeService.getQuote).toHaveBeenCalledWith('BTC-USD');
  });
});
