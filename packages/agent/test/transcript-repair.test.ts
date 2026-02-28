import { describe, it, expect } from 'vitest';
import type { TranscriptEntry } from '../src/agents/session/transcript-repair.js';
import { detectCorruption, repairTranscript } from '../src/agents/session/transcript-repair.js';

// ── 헬퍼 ──

function makeEntry(overrides?: Partial<TranscriptEntry>): TranscriptEntry {
  return {
    role: 'user',
    content: 'hello',
    timestamp: '2024-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('detectCorruption', () => {
  it('정상 트랜스크립트는 손상 없음', () => {
    const entries: TranscriptEntry[] = [
      makeEntry({ role: 'user', content: 'hi', timestamp: 't1' }),
      makeEntry({ role: 'assistant', content: 'hello', timestamp: 't2' }),
    ];
    const report = detectCorruption(entries);

    expect(report.corruptions).toHaveLength(0);
    expect(report.isRecoverable).toBe(true);
  });

  it('중복 엔트리를 감지한다', () => {
    const entries: TranscriptEntry[] = [
      makeEntry({ role: 'user', content: 'hi', timestamp: 't1' }),
      makeEntry({ role: 'user', content: 'hi', timestamp: 't1' }),
    ];
    const report = detectCorruption(entries);

    expect(report.corruptions).toHaveLength(1);
    expect(report.corruptions[0].type).toBe('duplicate-entry');
  });

  it('orphan tool result를 감지한다', () => {
    const entries: TranscriptEntry[] = [
      makeEntry({ role: 'user', content: 'hi', timestamp: 't1' }),
      makeEntry({
        role: 'tool',
        content: 'result',
        timestamp: 't2',
        toolUseId: 'tu-1',
        toolName: 'test-tool',
      }),
    ];
    const report = detectCorruption(entries);

    const orphan = report.corruptions.find((c) => c.type === 'orphan-tool-result');
    expect(orphan).toBeDefined();
  });

  it('missing tool result를 감지한다', () => {
    const entries: TranscriptEntry[] = [
      makeEntry({ role: 'user', content: 'hi', timestamp: 't1' }),
      makeEntry({
        role: 'assistant',
        content: 'using tool',
        timestamp: 't2',
        toolUseId: 'tu-1',
      }),
      // tool result 누락
      makeEntry({ role: 'user', content: 'next', timestamp: 't3' }),
    ];
    const report = detectCorruption(entries);

    const missing = report.corruptions.find((c) => c.type === 'missing-tool-result');
    expect(missing).toBeDefined();
  });

  it('빈 tool content (abort)를 감지한다', () => {
    const entries: TranscriptEntry[] = [
      makeEntry({ role: 'assistant', content: 'call', timestamp: 't1', toolUseId: 'tu-1' }),
      makeEntry({ role: 'tool', content: '', timestamp: 't2', toolUseId: 'tu-1' }),
    ];
    const report = detectCorruption(entries);

    const empty = report.corruptions.find(
      (c) => c.type === 'missing-tool-result' && c.description.includes('Empty'),
    );
    expect(empty).toBeDefined();
  });

  it('invalid role sequence를 감지한다', () => {
    const entries: TranscriptEntry[] = [
      makeEntry({ role: 'user', content: 'hi', timestamp: 't1' }),
      makeEntry({ role: 'tool', content: 'result', timestamp: 't2' }),
    ];
    const report = detectCorruption(entries);

    const invalid = report.corruptions.find((c) => c.type === 'invalid-role-sequence');
    expect(invalid).toBeDefined();
  });
});

describe('repairTranscript', () => {
  it('중복 엔트리를 제거한다', () => {
    const entries: TranscriptEntry[] = [
      makeEntry({ role: 'user', content: 'hi', timestamp: 't1' }),
      makeEntry({ role: 'user', content: 'hi', timestamp: 't1' }),
      makeEntry({ role: 'assistant', content: 'hello', timestamp: 't2' }),
    ];
    const report = detectCorruption(entries);
    const repaired = repairTranscript(entries, report);

    expect(repaired).toHaveLength(2);
    expect(repaired[0].content).toBe('hi');
    expect(repaired[1].content).toBe('hello');
  });

  it('orphan tool result에 합성 assistant를 삽입한다', () => {
    const entries: TranscriptEntry[] = [
      makeEntry({ role: 'user', content: 'hi', timestamp: 't1' }),
      makeEntry({
        role: 'tool',
        content: 'result',
        timestamp: 't2',
        toolUseId: 'tu-1',
        toolName: 'test-tool',
      }),
    ];
    const report = detectCorruption(entries);
    const repaired = repairTranscript(entries, report);

    // orphan 앞에 합성 assistant가 삽입되어야 함
    const syntheticAssistant = repaired.find(
      (e) => e.role === 'assistant' && e.content.includes('Synthetic'),
    );
    expect(syntheticAssistant).toBeDefined();
  });

  it('missing tool result에 합성 tool result를 삽입한다', () => {
    const entries: TranscriptEntry[] = [
      makeEntry({ role: 'user', content: 'hi', timestamp: 't1' }),
      makeEntry({
        role: 'assistant',
        content: 'using tool',
        timestamp: 't2',
        toolUseId: 'tu-1',
      }),
      makeEntry({ role: 'user', content: 'next', timestamp: 't3' }),
    ];
    const report = detectCorruption(entries);
    const repaired = repairTranscript(entries, report);

    const syntheticTool = repaired.find(
      (e) => e.role === 'tool' && e.content.includes('unavailable'),
    );
    expect(syntheticTool).toBeDefined();
  });

  it('빈 tool content를 "[Execution aborted]"로 교체한다', () => {
    const entries: TranscriptEntry[] = [
      makeEntry({ role: 'assistant', content: 'call', timestamp: 't1', toolUseId: 'tu-1' }),
      makeEntry({ role: 'tool', content: '', timestamp: 't2', toolUseId: 'tu-1' }),
    ];
    const report = detectCorruption(entries);
    const repaired = repairTranscript(entries, report);

    const aborted = repaired.find((e) => e.content === '[Execution aborted]');
    expect(aborted).toBeDefined();
  });
});
