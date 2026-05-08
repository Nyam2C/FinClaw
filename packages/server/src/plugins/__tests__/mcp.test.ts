// Phase 29 D11: MCP plugin e2e — mock stdio MCP 서버 1개를 spawn 하여
// loader 가 도구를 ToolRegistry 에 등록하는지 검증.
//
// CLAUDE.md feedback_tests_no_api_keys 준수: 외부 API 키 불필요 (mock stdio 서버만).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { InMemoryToolRegistry } from '@finclaw/agent';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPlugins } from '../loader.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_PATH = join(__dirname, 'fixtures', 'mock-mcp-server.mjs');

describe('MCP plugin e2e (Phase 29 D)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'finclaw-mcp-test-'));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it(
    'manifest.mcpServers 가 있으면 도구가 ToolRegistry 에 mcp:* 로 등록된다',
    { timeout: 30_000 },
    async () => {
      const pluginDir = join(tmpDir, 'echo-plugin');
      mkdirSync(pluginDir, { recursive: true });

      writeFileSync(join(pluginDir, 'index.js'), `export const register = () => {};\n`);
      writeFileSync(
        join(pluginDir, 'finclaw-plugin.json'),
        JSON.stringify({
          name: 'echo-plugin',
          version: '0.1.0',
          main: 'index.js',
          type: 'tool',
          mcpServers: [
            {
              id: 'echo',
              command: process.execPath,
              args: [FIXTURE_PATH],
            },
          ],
        }),
      );

      const registry = new InMemoryToolRegistry();
      const result = await loadPlugins([tmpDir], [tmpDir], registry);

      try {
        expect(result.loaded).toContain('echo-plugin');
        expect(result.mcpHandles.length).toBe(1);
        const echoTools = registry.list().filter((t) => t.definition.group === 'mcp');
        expect(echoTools.length).toBeGreaterThanOrEqual(1);
        // 도구명 namespace: mcp:<spec.id>:<original_name>
        expect(echoTools.some((t) => t.definition.name === 'mcp:echo:echo')).toBe(true);
      } finally {
        for (const h of result.mcpHandles) {
          await h.shutdown();
        }
      }
    },
  );

  it(
    'mcpServers 가 있어도 toolRegistry 미주입 시 warn diagnostic + skip',
    { timeout: 15_000 },
    async () => {
      const pluginDir = join(tmpDir, 'no-reg-plugin');
      mkdirSync(pluginDir, { recursive: true });
      writeFileSync(join(pluginDir, 'index.js'), `export const register = () => {};\n`);
      writeFileSync(
        join(pluginDir, 'finclaw-plugin.json'),
        JSON.stringify({
          name: 'no-reg-plugin',
          version: '0.1.0',
          main: 'index.js',
          type: 'tool',
          mcpServers: [{ id: 'echo', command: process.execPath, args: [FIXTURE_PATH] }],
        }),
      );

      const result = await loadPlugins([tmpDir], [tmpDir]); // toolRegistry 미주입
      expect(result.loaded).toContain('no-reg-plugin');
      expect(result.mcpHandles.length).toBe(0);
    },
  );
});
