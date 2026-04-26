import { describe, expect, it } from 'vitest';
import {
  loadAnalysisPrompt,
  loadSentimentPrompt,
  SkillPromptLoadError,
  type AnalysisDepth,
  type AnalysisLanguage,
} from '../prompt-loader.js';

describe('loadAnalysisPrompt', () => {
  const depths: readonly AnalysisDepth[] = ['brief', 'standard', 'detailed'];
  const langs: readonly AnalysisLanguage[] = ['ko', 'en'];

  for (const d of depths) {
    for (const l of langs) {
      it(`loads ${d}.${l}`, async () => {
        const text = await loadAnalysisPrompt(d, l);
        expect(text).toContain('Response format (strict JSON');
        expect(text.length).toBeGreaterThan(50);
      });
    }
  }

  it('language directive switches per language', async () => {
    expect(await loadAnalysisPrompt('standard', 'ko')).toContain('한국어로');
    expect(await loadAnalysisPrompt('standard', 'en')).toContain(
      'Write analysis results in English',
    );
  });

  it('depth directive switches per depth', async () => {
    expect(await loadAnalysisPrompt('brief', 'ko')).toContain('1-2 sentences');
    expect(await loadAnalysisPrompt('detailed', 'ko')).toContain('thorough analysis');
    expect(await loadAnalysisPrompt('standard', 'ko')).toContain('moderate-length');
  });
});

describe('loadSentimentPrompt', () => {
  it('substitutes {{ruleHint}} with 2-decimal value', async () => {
    const text = await loadSentimentPrompt(0.4);
    expect(text).toContain('hint score: 0.40');
    expect(text).not.toContain('{{ruleHint}}');
  });

  it('rounds to 2 decimals', async () => {
    expect(await loadSentimentPrompt(0.4567)).toContain('hint score: 0.46');
  });

  it('handles negative values', async () => {
    expect(await loadSentimentPrompt(-0.5)).toContain('hint score: -0.50');
  });

  it('handles zero', async () => {
    expect(await loadSentimentPrompt(0)).toContain('hint score: 0.00');
  });
});

describe('SkillPromptLoadError', () => {
  it('reports searchDir + filename + caller hint when file missing', async () => {
    try {
      // 일부러 존재하지 않는 조합. depth 타입 체크는 우회 (테스트 의도).
      await loadAnalysisPrompt('foo' as AnalysisDepth, 'ko');
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(SkillPromptLoadError);
      const err = e as SkillPromptLoadError;
      expect(err.filename).toBe('analyze.foo.ko.md');
      expect(err.message).toContain('searched in:');
      expect(err.message).toContain('required by: loadAnalysisPrompt(foo,ko)');
      expect(err.searchDir).toMatch(/prompts\/news$/);
    }
  });
});
