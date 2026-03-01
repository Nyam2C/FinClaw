import { describe, it, expect, beforeEach } from 'vitest';
import type { StreamChunk } from '../src/models/provider-normalize.js';
import { ToolInputBuffer } from '../src/execution/tool-input-buffer.js';

describe('ToolInputBuffer', () => {
  let buffer: ToolInputBuffer;

  beforeEach(() => {
    buffer = new ToolInputBuffer();
  });

  it('tool_use_start → input_delta → tool_use_end 시퀀스로 ToolCall을 조립한다', () => {
    expect(buffer.feed({ type: 'tool_use_start', id: 'call_1', name: 'get_price' })).toBeNull();
    expect(buffer.feed({ type: 'tool_input_delta', delta: '{"tic' })).toBeNull();
    expect(buffer.feed({ type: 'tool_input_delta', delta: 'ker":"AAPL"}' })).toBeNull();

    const result = buffer.feed({ type: 'tool_use_end' });
    expect(result).toEqual({
      id: 'call_1',
      name: 'get_price',
      input: { ticker: 'AAPL' },
    });
  });

  it('빈 input으로 tool_use_end가 오면 빈 객체를 반환한다', () => {
    buffer.feed({ type: 'tool_use_start', id: 'call_2', name: 'list_tools' });
    const result = buffer.feed({ type: 'tool_use_end' });
    expect(result).toEqual({ id: 'call_2', name: 'list_tools', input: {} });
  });

  it('pending 없이 tool_use_end가 오면 null을 반환한다', () => {
    expect(buffer.feed({ type: 'tool_use_end' })).toBeNull();
  });

  it('pending 없이 tool_input_delta가 오면 무시한다', () => {
    expect(buffer.feed({ type: 'tool_input_delta', delta: '{"x":1}' })).toBeNull();
  });

  it('text_delta, usage, done 청크는 null을 반환한다', () => {
    const irrelevant: StreamChunk[] = [
      { type: 'text_delta', text: 'hello' },
      { type: 'usage', usage: { inputTokens: 100 } },
      { type: 'done' },
    ];
    for (const chunk of irrelevant) {
      expect(buffer.feed(chunk)).toBeNull();
    }
  });

  it('reset()은 진행 중인 버퍼를 초기화한다', () => {
    buffer.feed({ type: 'tool_use_start', id: 'call_3', name: 'test' });
    buffer.feed({ type: 'tool_input_delta', delta: '{"a":1' });
    buffer.reset();
    // reset 후 tool_use_end는 null (pending 없음)
    expect(buffer.feed({ type: 'tool_use_end' })).toBeNull();
  });

  it('연속 도구 호출을 순차적으로 처리한다', () => {
    buffer.feed({ type: 'tool_use_start', id: 'c1', name: 'tool_a' });
    buffer.feed({ type: 'tool_input_delta', delta: '{}' });
    const r1 = buffer.feed({ type: 'tool_use_end' });
    expect(r1).toEqual({ id: 'c1', name: 'tool_a', input: {} });

    buffer.feed({ type: 'tool_use_start', id: 'c2', name: 'tool_b' });
    buffer.feed({ type: 'tool_input_delta', delta: '{"v":2}' });
    const r2 = buffer.feed({ type: 'tool_use_end' });
    expect(r2).toEqual({ id: 'c2', name: 'tool_b', input: { v: 2 } });
  });
});
