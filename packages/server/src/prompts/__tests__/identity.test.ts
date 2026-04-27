import { describe, expect, it } from 'vitest';
import { loadPrompt } from '../loader.js';

describe('finclaw.identity.md (golden)', () => {
  it('frontmatter exposes agent.list metadata', async () => {
    const doc = await loadPrompt('finclaw.identity.md', 'identity-test');
    expect(doc.frontmatter).toMatchObject({
      id: 'finclaw-partner',
      name: 'FinClaw Personal Finance Partner',
      description: '개인 금융 파트너. 시세 조회·뉴스·포트폴리오·알림 관리.',
    });
  });

  it('body contains the 5 core principles (regression guard)', async () => {
    const { body } = await loadPrompt('finclaw.identity.md', 'identity-test');
    for (const kw of ['읽기 전용', '환각 금지', '출처 명시', '불확실성 수치화', '간결한 한국어']) {
      expect(body).toContain(kw);
    }
  });
});

describe('finclaw.system.ko.md (golden)', () => {
  it('contains identity principles + tools section + tool-result handling', async () => {
    const { body } = await loadPrompt('finclaw.system.ko.md', 'identity-test');
    for (const kw of [
      '읽기 전용',
      '환각 금지',
      '출처 명시',
      '불확실성 수치화',
      '간결한 한국어',
      '## 사용 가능한 도구',
      '## 도구 결과 처리',
      'analyze_market',
    ]) {
      expect(body).toContain(kw);
    }
  });

  it('persona core lines do not drift from identity.md', async () => {
    const id = await loadPrompt('finclaw.identity.md', 'identity-test');
    const sys = await loadPrompt('finclaw.system.ko.md', 'identity-test');
    const personaLines = id.body
      .split('\n')
      .filter((l) => l.trim().startsWith('너는') || /^\d+\.\s/.test(l.trim()));
    expect(personaLines.length).toBeGreaterThanOrEqual(6);
    for (const line of personaLines) {
      expect(sys.body).toContain(line);
    }
  });
});
