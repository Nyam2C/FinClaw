// packages/server/test/channels/chat-type.test.ts
import { describe, it, expect } from 'vitest';
import { normalizeChatType, isDirect, isMultiUser } from '../../src/channels/chat-type.js';

describe('normalizeChatType', () => {
  it.each([
    ['direct', 'direct'],
    ['dm', 'direct'],
    ['DM', 'direct'],
    ['private', 'direct'],
    ['whisper', 'direct'],
    ['DIRECT', 'direct'],
  ] as const)('"%s" → "%s"', (input, expected) => {
    expect(normalizeChatType(input)).toBe(expected);
  });

  it.each([
    ['group', 'group'],
    ['room', 'group'],
    ['chat', 'group'],
    ['GROUP', 'group'],
  ] as const)('"%s" → "%s"', (input, expected) => {
    expect(normalizeChatType(input)).toBe(expected);
  });

  it.each([
    ['channel', 'channel'],
    ['public', 'channel'],
    ['forum', 'channel'],
    ['CHANNEL', 'channel'],
  ] as const)('"%s" → "%s"', (input, expected) => {
    expect(normalizeChatType(input)).toBe(expected);
  });

  it('알 수 없는 값은 group으로 폴백한다', () => {
    expect(normalizeChatType('unknown')).toBe('group');
    expect(normalizeChatType('')).toBe('group');
  });

  it('공백을 제거한다', () => {
    expect(normalizeChatType('  dm  ')).toBe('direct');
  });
});

describe('isDirect', () => {
  it('direct이면 true', () => {
    expect(isDirect('direct')).toBe(true);
  });

  it('group이면 false', () => {
    expect(isDirect('group')).toBe(false);
  });

  it('channel이면 false', () => {
    expect(isDirect('channel')).toBe(false);
  });
});

describe('isMultiUser', () => {
  it('group이면 true', () => {
    expect(isMultiUser('group')).toBe(true);
  });

  it('channel이면 true', () => {
    expect(isMultiUser('channel')).toBe(true);
  });

  it('direct이면 false', () => {
    expect(isMultiUser('direct')).toBe(false);
  });
});
