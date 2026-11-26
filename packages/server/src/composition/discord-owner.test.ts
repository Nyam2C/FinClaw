import { describe, expect, it } from 'vitest';
import { isDiscordOwner } from './discord-owner.js';

describe('isDiscordOwner', () => {
  it('소유자 id 와 같은 발신자만 통과한다', () => {
    expect(isDiscordOwner('111', '111')).toBe(true);
    expect(isDiscordOwner('222', '111')).toBe(false);
  });

  it('소유자 id 가 없으면 아무도 통과하지 못한다', () => {
    expect(isDiscordOwner('111', undefined)).toBe(false);
  });
});
