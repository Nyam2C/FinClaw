import { describe, expect, it } from 'vitest';
import { loadAnalysisPrompt } from '../prompt-loader.js';

describe('loadAnalysisPrompt', () => {
  it('loads standard.ko', async () => {
    const text = await loadAnalysisPrompt();
    expect(text).toContain('Response format (strict JSON');
    expect(text).toContain('Output language: 한국어');
    expect(text).toContain('Detail level: standard');
  });
});
