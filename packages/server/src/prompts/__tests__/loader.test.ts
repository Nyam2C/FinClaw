import { describe, expect, it } from 'vitest';
import { loadPrompt, parsePrompt, PromptLoadError, requireFrontmatterKeys } from '../loader.js';

describe('parsePrompt', () => {
  it('parses frontmatter and body', () => {
    const raw = '---\nid: foo\nname: Bar\n---\n\nbody text';
    const doc = parsePrompt(raw);
    expect(doc.frontmatter.id).toBe('foo');
    expect(doc.frontmatter.name).toBe('Bar');
    expect(doc.body).toBe('body text');
  });

  it('returns body verbatim when no frontmatter', () => {
    const doc = parsePrompt('plain body');
    expect(doc.body).toBe('plain body');
    expect(doc.frontmatter).toEqual({});
  });

  it('handles values containing colons (URL etc.)', () => {
    const doc = parsePrompt('---\nurl: https://example.com\n---\nx');
    expect(doc.frontmatter.url).toBe('https://example.com');
  });

  it('skips blank/comment lines in frontmatter', () => {
    const doc = parsePrompt('---\n# comment\n\nid: foo\n---\nbody');
    expect(doc.frontmatter).toEqual({ id: 'foo' });
  });

  it('trims body trailing whitespace', () => {
    const doc = parsePrompt('---\nid: foo\n---\nbody\n\n\n');
    expect(doc.body).toBe('body');
  });
});

describe('loadPrompt', () => {
  it('loads finclaw.identity.md from disk', async () => {
    const doc = await loadPrompt('finclaw.identity.md', 'unit-test');
    expect(doc.frontmatter.id).toBe('finclaw-partner');
    expect(doc.body).toContain('FinClaw');
  });

  it('throws PromptLoadError with searchDir + filename + caller hint for missing file', async () => {
    await expect(loadPrompt('does-not-exist.md', 'unit-test')).rejects.toBeInstanceOf(
      PromptLoadError,
    );
    try {
      await loadPrompt('does-not-exist.md', 'unit-test');
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(PromptLoadError);
      const err = e as PromptLoadError;
      expect(err.filename).toBe('does-not-exist.md');
      expect(err.message).toContain('searched in:');
      expect(err.message).toContain('required by: unit-test');
      expect(err.searchDir).toMatch(/prompts$/);
    }
  });
});

describe('requireFrontmatterKeys', () => {
  it('passes when all keys present', () => {
    const doc = { frontmatter: { id: 'x', name: 'y' }, body: '' };
    expect(() => requireFrontmatterKeys(doc, 'foo.md', ['id', 'name'], 'test')).not.toThrow();
  });

  it('throws PromptLoadError with missingKey populated', () => {
    const doc = { frontmatter: { id: 'x' }, body: '' };
    try {
      requireFrontmatterKeys(doc, 'foo.md', ['id', 'name'], 'unit-test');
      expect.fail('should have thrown');
    } catch (e) {
      expect(e).toBeInstanceOf(PromptLoadError);
      const err = e as PromptLoadError;
      expect(err.missingKey).toBe('name');
      expect(err.filename).toBe('foo.md');
      expect(err.message).toContain("Missing frontmatter key 'name'");
      expect(err.message).toContain('required by: unit-test');
    }
  });
});
