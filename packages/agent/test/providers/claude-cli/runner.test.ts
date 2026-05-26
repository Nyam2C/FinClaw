import { describe, it, expect, vi } from 'vitest';
import { DEFAULT_CLAUDE_BACKEND } from '../../../src/providers/claude-cli/backends.js';
import { runCliAgent } from '../../../src/providers/claude-cli/runner.js';
import * as spawnMod from '../../../src/providers/claude-cli/spawn.js';

describe('runCliAgent', () => {
  it('returns text on successful claude json output', async () => {
    vi.spyOn(spawnMod, 'spawnWithWatchdog').mockResolvedValue({
      exitCode: 0,
      reason: 'exit',
      stdout: JSON.stringify({
        type: 'result',
        result: '안녕',
        session_id: 'sess1',
        usage: { input_tokens: 10, output_tokens: 5 },
      }),
      stderr: '',
      noOutputTimedOut: false,
      durationMs: 100,
    });
    const r = await runCliAgent({ prompt: 'hi', timeoutMs: 60_000 });
    expect(r.text).toBe('안녕');
    expect(r.sessionId).toBe('sess1');
    expect(r.usage?.input).toBe(10);
  });

  it('throws CliFailoverError(timeout) on no-output-timeout', async () => {
    vi.spyOn(spawnMod, 'spawnWithWatchdog').mockResolvedValue({
      exitCode: null,
      reason: 'no-output-timeout',
      stdout: '',
      stderr: '',
      noOutputTimedOut: true,
      durationMs: 30_000,
    });
    await expect(runCliAgent({ prompt: 'hi' })).rejects.toMatchObject({
      name: 'CliFailoverError',
      reason: 'timeout',
    });
  });

  it('throws CliFailoverError(auth) on auth failure stderr', async () => {
    vi.spyOn(spawnMod, 'spawnWithWatchdog').mockResolvedValue({
      exitCode: 1,
      reason: 'exit',
      stdout: '',
      stderr: 'Please log in via `claude login`.',
      noOutputTimedOut: false,
      durationMs: 100,
    });
    await expect(runCliAgent({ prompt: 'hi' })).rejects.toMatchObject({
      reason: 'auth',
    });
  });

  it('clears ANTHROPIC_API_KEY in spawned env', async () => {
    let capturedEnv: NodeJS.ProcessEnv = {};
    vi.spyOn(spawnMod, 'spawnWithWatchdog').mockImplementation(async (req) => {
      capturedEnv = req.env ?? {};
      return {
        exitCode: 0,
        reason: 'exit',
        stdout: '{"result":"ok"}',
        stderr: '',
        noOutputTimedOut: false,
        durationMs: 50,
      };
    });
    process.env.ANTHROPIC_API_KEY = 'sk-test';
    await runCliAgent({ prompt: 'hi' });
    expect(capturedEnv.ANTHROPIC_API_KEY).toBeUndefined();
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('uses --resume args when cliSessionId given', async () => {
    let capturedArgv: string[] = [];
    vi.spyOn(spawnMod, 'spawnWithWatchdog').mockImplementation(async (req) => {
      capturedArgv = req.argv;
      return {
        exitCode: 0,
        reason: 'exit',
        stdout: '{"result":"ok"}',
        stderr: '',
        noOutputTimedOut: false,
        durationMs: 50,
      };
    });
    await runCliAgent({ prompt: 'hi', cliSessionId: 'sess1' });
    expect(capturedArgv).toContain('--resume');
    expect(capturedArgv).toContain('sess1');
  });

  it('injects --mcp-config(http) + isolation flags when backend.mcp is set', async () => {
    let capturedArgv: string[] = [];
    vi.spyOn(spawnMod, 'spawnWithWatchdog').mockImplementation(async (req) => {
      capturedArgv = req.argv;
      return {
        exitCode: 0,
        reason: 'exit',
        stdout: '{"result":"ok"}',
        stderr: '',
        noOutputTimedOut: false,
        durationMs: 50,
      };
    });
    await runCliAgent({
      prompt: 'hi',
      backend: {
        ...DEFAULT_CLAUDE_BACKEND,
        mcp: {
          url: 'http://127.0.0.1:3000/mcp',
          mintToken: () => 'TOKEN123',
          allowedTools: 'mcp__finclaw__*',
        },
      },
    });
    expect(capturedArgv).toContain('--mcp-config');
    expect(capturedArgv).toContain('--strict-mcp-config');
    expect(capturedArgv).toContain('--allowedTools');
    expect(capturedArgv).toContain('mcp__finclaw__*');
    // --tools "" 격리 (빈 문자열 인자).
    const toolsIdx = capturedArgv.indexOf('--tools');
    expect(toolsIdx).toBeGreaterThanOrEqual(0);
    expect(capturedArgv[toolsIdx + 1]).toBe('');
    // --mcp-config JSON: http transport + Bearer 토큰.
    const cfg = JSON.parse(capturedArgv[capturedArgv.indexOf('--mcp-config') + 1]);
    expect(cfg.mcpServers.finclaw.type).toBe('http');
    expect(cfg.mcpServers.finclaw.url).toBe('http://127.0.0.1:3000/mcp');
    expect(cfg.mcpServers.finclaw.headers.Authorization).toBe('Bearer TOKEN123');
  });

  it('omits MCP flags when backend.mcp is absent (회귀: 기존 텍스트 전용 동작)', async () => {
    let capturedArgv: string[] = [];
    vi.spyOn(spawnMod, 'spawnWithWatchdog').mockImplementation(async (req) => {
      capturedArgv = req.argv;
      return {
        exitCode: 0,
        reason: 'exit',
        stdout: '{"result":"ok"}',
        stderr: '',
        noOutputTimedOut: false,
        durationMs: 50,
      };
    });
    await runCliAgent({ prompt: 'hi' });
    expect(capturedArgv).not.toContain('--mcp-config');
    expect(capturedArgv).not.toContain('--strict-mcp-config');
  });
});
