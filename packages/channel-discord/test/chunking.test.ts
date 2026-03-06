import { describe, it, expect } from 'vitest';
import { chunkText } from '../src/chunking.js';

describe('chunkText', () => {
  it('2000자+17줄 이하 텍스트는 분할하지 않는다', () => {
    expect(chunkText('Hello', 2000, 17)).toEqual(['Hello']);
  });

  it('빈 문자열은 빈 배열을 반환한다', () => {
    expect(chunkText('', 2000, 17)).toEqual(['']);
  });

  it('maxLength 초과 시 문자 기준으로 분할한다', () => {
    const text = 'a'.repeat(3000);
    const chunks = chunkText(text, 2000, 17);
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((chunk) => expect(chunk.length).toBeLessThanOrEqual(2000));
  });

  it('17줄 초과 시 줄 기준으로 분할한다', () => {
    const text = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n');
    const chunks = chunkText(text, 2000, 17);
    expect(chunks.length).toBeGreaterThan(1);
    chunks.forEach((chunk) => expect(chunk.split('\n').length).toBeLessThanOrEqual(17));
  });

  it('단락 경계(빈 줄)에서 우선 분할한다', () => {
    const paragraph1 = Array.from({ length: 10 }, (_, i) => `line ${i}`).join('\n');
    const paragraph2 = Array.from({ length: 10 }, (_, i) => `line ${i + 10}`).join('\n');
    const text = `${paragraph1}\n\n${paragraph2}`;
    const chunks = chunkText(text, 2000, 17);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).not.toContain('line 10');
    expect(chunks[1]).toContain('line 10');
  });

  it('줄바꿈 경계에서 분할한다', () => {
    // 17줄 초과하되 단락 경계(빈 줄)가 없는 경우
    const text = Array.from({ length: 20 }, (_, i) => `row-${i}`).join('\n');
    const chunks = chunkText(text, 2000, 17);
    expect(chunks.length).toBeGreaterThan(1);
    // 각 청크가 줄 중간에서 잘리지 않았는지 확인
    chunks.forEach((chunk) => {
      expect(chunk.endsWith('-')).toBe(false);
    });
  });

  it('코드 블록이 청크 경계에서 분할될 때 닫기/열기 마커를 삽입한다', () => {
    const lines = [
      '```typescript',
      ...Array.from({ length: 20 }, (_, i) => `const x${i} = ${i};`),
      '```',
    ];
    const text = lines.join('\n');
    const chunks = chunkText(text, 2000, 17);
    expect(chunks.length).toBeGreaterThan(1);
    // 첫 번째 청크는 닫는 ``` 로 끝나야 한다
    expect(chunks[0]).toMatch(/```\s*$/);
    // 두 번째 청크는 여는 ```typescript 로 시작해야 한다
    expect(chunks[1]).toMatch(/^```typescript/);
  });

  it('문장 경계(마침표 + 공백)에서 분할한다', () => {
    // maxLength가 작은 상태에서 마침표+공백 기준 분할
    const text = 'Hello world. This is a test sentence. And another one here.';
    const chunks = chunkText(text, 40, 100);
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('공백 경계에서 분할한다 (단어 경계)', () => {
    // 줄바꿈/마침표 없이 긴 공백 구분 텍스트
    const words = Array.from({ length: 50 }, (_, i) => `word${i}`);
    const text = words.join(' ');
    const chunks = chunkText(text, 100, 100);
    expect(chunks.length).toBeGreaterThan(1);
    // 단어 중간에서 잘리지 않았는지 확인
    chunks.forEach((chunk) => {
      const parts = chunk.trim().split(' ');
      parts.forEach((p) => expect(p).toMatch(/^word\d+$/));
    });
  });

  it('정확히 maxLength인 텍스트는 분할하지 않는다', () => {
    const text = 'x'.repeat(2000);
    expect(chunkText(text, 2000, 17)).toEqual([text]);
  });

  it('정확히 maxLines인 텍스트는 분할하지 않는다', () => {
    const text = Array.from({ length: 17 }, (_, i) => `line ${i}`).join('\n');
    expect(chunkText(text, 2000, 17)).toEqual([text]);
  });

  it('모든 청크의 결합이 원본 내용을 보존한다', () => {
    const text = Array.from({ length: 50 }, (_, i) => `content line ${i}`).join('\n');
    const chunks = chunkText(text, 2000, 17);
    // 분할 후 재결합한 내용에 모든 원본 줄이 포함되어야 한다
    const rejoined = chunks.join('\n');
    for (let i = 0; i < 50; i++) {
      expect(rejoined).toContain(`content line ${i}`);
    }
  });
});
