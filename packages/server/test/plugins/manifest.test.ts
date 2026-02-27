// packages/server/test/plugins/manifest.test.ts
import { describe, it, expect } from 'vitest';
import {
  parseManifest,
  PluginManifestSchema,
  manifestJsonSchema,
} from '../../src/plugins/manifest.js';

const validManifest = {
  name: 'test-plugin',
  version: '1.0.0',
  description: 'A test plugin',
  author: 'tester',
  main: 'src/index.ts',
  type: 'channel' as const,
  dependencies: ['other-plugin'],
  slots: ['channels', 'hooks'],
  config: { key: 'value' },
};

describe('parseManifest', () => {
  it('유효한 매니페스트를 파싱한다', () => {
    const result = parseManifest(validManifest);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.manifest.name).toBe('test-plugin');
      expect(result.manifest.version).toBe('1.0.0');
      expect(result.manifest.type).toBe('channel');
    }
  });

  it('최소 필드만으로 유효하다', () => {
    const result = parseManifest({
      name: 'minimal',
      version: '0.1.0',
      main: 'index.js',
      type: 'service',
    });
    expect(result.ok).toBe(true);
  });

  it('name이 빈 문자열이면 거부한다', () => {
    const result = parseManifest({ ...validManifest, name: '' });
    expect(result.ok).toBe(false);
  });

  it('version이 semver 형식이 아니면 거부한다', () => {
    const result = parseManifest({ ...validManifest, version: 'latest' });
    expect(result.ok).toBe(false);
  });

  it('main이 없으면 거부한다', () => {
    const { main: _, ...noMain } = validManifest;
    const result = parseManifest(noMain);
    expect(result.ok).toBe(false);
  });

  it('잘못된 type을 거부한다', () => {
    const result = parseManifest({ ...validManifest, type: 'unknown' });
    expect(result.ok).toBe(false);
  });

  it('알 수 없는 키를 거부한다 (strictObject)', () => {
    const result = parseManifest({ ...validManifest, unknownKey: true });
    expect(result.ok).toBe(false);
  });

  it('실패 시 에러 메시지를 포함한다', () => {
    const result = parseManifest({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.length).toBeGreaterThan(0);
    }
  });
});

describe('PluginManifestSchema', () => {
  it('4가지 type을 모두 허용한다', () => {
    for (const type of ['channel', 'skill', 'tool', 'service']) {
      const result = PluginManifestSchema.safeParse({
        name: 'test',
        version: '1.0.0',
        main: 'index.js',
        type,
      });
      expect(result.success).toBe(true);
    }
  });

  it('config는 임의의 Record를 허용한다', () => {
    const result = PluginManifestSchema.safeParse({
      name: 'test',
      version: '1.0.0',
      main: 'index.js',
      type: 'service',
      config: { nested: { deep: true }, arr: [1, 2, 3] },
    });
    expect(result.success).toBe(true);
  });
});

describe('manifestJsonSchema', () => {
  it('JSON Schema 객체를 반환한다', () => {
    expect(manifestJsonSchema).toBeDefined();
    expect(typeof manifestJsonSchema).toBe('object');
  });

  it('필수 필드 정보를 포함한다', () => {
    const schema = manifestJsonSchema as Record<string, unknown>;
    expect(schema).toHaveProperty('type', 'object');
  });
});
