import { execSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import { runCliAgent } from '../../../src/providers/claude-cli/runner.js';

const claudeAvailable = (() => {
  try {
    execSync('which claude', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!claudeAvailable)('runCliAgent (live)', () => {
  it('returns response from real claude CLI', async () => {
    const r = await runCliAgent({
      prompt: '한국어로 "안녕"이라고만 답해줘.',
      modelId: 'sonnet',
      timeoutMs: 60_000,
    });
    expect(r.text).toContain('안녕');
    expect(r.sessionId).toBeTruthy();
    expect(r.durationMs).toBeGreaterThan(0);
  }, 90_000);

  it('multi-turn with --resume', async () => {
    const turn1 = await runCliAgent({
      prompt: '내 이름은 testuser야.',
      modelId: 'sonnet',
      timeoutMs: 60_000,
    });
    expect(turn1.sessionId).toBeTruthy();

    const turn2 = await runCliAgent({
      prompt: '내 이름이 뭐야?',
      modelId: 'sonnet',
      cliSessionId: turn1.sessionId,
      timeoutMs: 60_000,
    });
    expect(turn2.text).toContain('testuser');
  }, 180_000);

  it('CLI uses OAuth even with ANTHROPIC_API_KEY set (clearEnv sanity)', async () => {
    // ANTHROPIC_API_KEY 가 환경에 있어도 CLI 가 OAuth 로 동작하는지 검증
    const original = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-invalid';
    try {
      const r = await runCliAgent({
        prompt: 'say ok',
        modelId: 'sonnet',
        timeoutMs: 30_000,
      });
      // CLI 가 OAuth 로 정상 동작하면 여전히 응답 받음
      expect(r.text).toBeTruthy();
    } finally {
      if (original) {
        process.env.ANTHROPIC_API_KEY = original;
      } else {
        delete process.env.ANTHROPIC_API_KEY;
      }
    }
  }, 60_000);
});
