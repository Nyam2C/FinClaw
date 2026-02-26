import { describe, it, expect } from 'vitest';
import { isMain } from '../src/is-main.js';

describe('isMain', () => {
  it('동일 경로면 true를 반환한다', () => {
    const fakeUrl = `file://${process.argv[1]}`;
    expect(isMain(fakeUrl)).toBe(true);
  });

  it('다른 경로면 false를 반환한다', () => {
    expect(isMain('file:///some/other/module.ts')).toBe(false);
  });

  it('잘못된 URL이면 false를 반환한다', () => {
    expect(isMain('not a url')).toBe(false);
  });
});
