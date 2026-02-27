import type { PluginDiagnostic } from '@finclaw/types';
// packages/server/test/plugins/diagnostics.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import {
  setPluginRegistry,
  createEmptyRegistry,
  registerToSlot,
  getSlot,
} from '../../src/plugins/registry.js';

beforeEach(() => {
  setPluginRegistry(createEmptyRegistry());
});

function addDiag(overrides: Partial<PluginDiagnostic> = {}): PluginDiagnostic {
  const diag: PluginDiagnostic = {
    pluginName: 'test-plugin',
    timestamp: Date.now(),
    severity: 'info',
    phase: 'runtime',
    message: 'test diagnostic',
    ...overrides,
  };
  registerToSlot('diagnostics', diag);
  return diag;
}

describe('diagnostics 슬롯', () => {
  it('진단 정보를 누적 기록한다', () => {
    addDiag({ message: 'first' });
    addDiag({ message: 'second' });
    addDiag({ message: 'third' });

    expect(getSlot('diagnostics')).toHaveLength(3);
  });

  it('severity별 필터링이 가능하다', () => {
    addDiag({ severity: 'info', message: 'info msg' });
    addDiag({ severity: 'warn', message: 'warn msg' });
    addDiag({ severity: 'error', message: 'error msg' });
    addDiag({ severity: 'error', message: 'another error' });

    const all = getSlot('diagnostics');
    const errors = all.filter((d) => d.severity === 'error');
    const warns = all.filter((d) => d.severity === 'warn');

    expect(errors).toHaveLength(2);
    expect(warns).toHaveLength(1);
  });

  it('phase별 필터링이 가능하다', () => {
    addDiag({ phase: 'discovery', message: 'disc' });
    addDiag({ phase: 'manifest', message: 'man' });
    addDiag({ phase: 'load', message: 'load' });
    addDiag({ phase: 'register', message: 'reg' });
    addDiag({ phase: 'runtime', message: 'rt' });

    const all = getSlot('diagnostics');
    expect(all.filter((d) => d.phase === 'load')).toHaveLength(1);
    expect(all.filter((d) => d.phase === 'runtime')).toHaveLength(1);
  });

  it('error 정보를 포함할 수 있다', () => {
    addDiag({
      severity: 'error',
      message: 'load failed',
      error: { code: 'MODULE_NOT_FOUND', stack: 'Error: ...' },
    });

    const diags = getSlot('diagnostics');
    expect(diags[0].error?.code).toBe('MODULE_NOT_FOUND');
  });

  it('pluginName으로 특정 플러그인의 진단을 조회한다', () => {
    addDiag({ pluginName: 'plugin-a', message: 'a1' });
    addDiag({ pluginName: 'plugin-b', message: 'b1' });
    addDiag({ pluginName: 'plugin-a', message: 'a2' });

    const all = getSlot('diagnostics');
    const pluginA = all.filter((d) => d.pluginName === 'plugin-a');
    expect(pluginA).toHaveLength(2);
  });
});
