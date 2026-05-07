// Phase 29 B: RAG 인용 추출 (extractCitedMemoryIds) 단위 검증.
// 가짜 retrievalResult.snippets 후보와 응답 텍스트의 [mem:xxxxxx] 마커를 매칭.
import { describe, expect, it } from 'vitest';
import { extractCitedMemoryIds } from '../execution-adapter.js';

describe('memory citation extraction (Phase 29 B)', () => {
  it('extracts [mem:xxxxxx] markers and matches by id prefix', () => {
    const candidates = [{ id: 'aaaaaa-1111-2222-3333' }, { id: 'bbbbbb-4444-5555-6666' }];
    const text = '손절 원칙은 -10% [mem:aaaaaa]. 그리고 분산투자 원칙은 [mem:bbbbbb] 였습니다.';
    expect(extractCitedMemoryIds(text, candidates)).toEqual([
      'aaaaaa-1111-2222-3333',
      'bbbbbb-4444-5555-6666',
    ]);
  });

  it('multi-id syntax [mem:aaa,bbb]', () => {
    const candidates = [{ id: 'aaaaaa-x' }, { id: 'bbbbbb-y' }];
    const text = '두 원칙 모두 적용 [mem:aaaaaa,bbbbbb].';
    expect(extractCitedMemoryIds(text, candidates).toSorted()).toEqual(['aaaaaa-x', 'bbbbbb-y']);
  });

  it('no markers → empty array', () => {
    expect(extractCitedMemoryIds('plain text', [{ id: 'abcdef-z' }])).toEqual([]);
  });

  it('marker without matching candidate → empty array', () => {
    expect(extractCitedMemoryIds('see [mem:cccccc].', [{ id: 'aaaaaa-x' }])).toEqual([]);
  });

  it('duplicate marker for same candidate → emitted once', () => {
    const candidates = [{ id: 'aaaaaa-1' }];
    expect(extractCitedMemoryIds('a [mem:aaaaaa] b [mem:aaaaaa]', candidates)).toEqual([
      'aaaaaa-1',
    ]);
  });
});
