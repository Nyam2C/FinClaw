import { describe, expect, it } from 'vitest';
import { loadPrompt } from '../loader.js';

describe('finclaw.system.ko.md (golden)', () => {
  it('frontmatter exposes agent.list metadata', async () => {
    const doc = await loadPrompt('finclaw.system.ko.md', 'system-prompt-test');
    expect(doc.frontmatter).toMatchObject({
      id: 'finclaw-partner',
      name: 'FinClaw Personal Finance Partner',
      description: '개인 금융 파트너. 시세 조회·뉴스·포트폴리오·알림 관리.',
    });
  });

  it('body contains core principles + tools section + tool-result handling', async () => {
    const { body } = await loadPrompt('finclaw.system.ko.md', 'system-prompt-test');
    for (const kw of [
      '읽기 전용',
      '환각 금지',
      '출처 명시',
      '불확실성 수치화',
      '간결한 한국어',
      '`<recent_conversation>`',
      '## 도구',
      'find_stock(query)',
      'get_holdings()',
      '## 도구 결과 처리',
      'market_analysis',
      '## 캐릭터 — 핀',
      '해요체',
    ]) {
      expect(body).toContain(kw);
    }
  });
});
