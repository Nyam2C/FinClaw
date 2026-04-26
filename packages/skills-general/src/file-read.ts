// packages/skills-general/src/file-read.ts
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import type { RegisteredToolDefinition, ToolExecutor, ToolRegistry } from '@finclaw/agent';

export interface FileReadConfig {
  readonly fileRoot: string;
  readonly maxBytes: number;
}

export function registerFileReadTool(registry: ToolRegistry, config: FileReadConfig): void {
  const def: RegisteredToolDefinition = {
    name: 'read_local_file',
    description: `로컬 파일을 읽습니다. 안전 루트(${config.fileRoot}) 하위의 상대 경로 파일만 접근 가능합니다. 심볼릭 링크가 루트를 벗어나면 거부됩니다.`,
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'FILE_ROOT 기준 상대 경로' },
        max_bytes: {
          type: 'number',
          description: '최대 읽을 바이트 수 (기본 config.maxBytes)',
        },
      },
      required: ['path'],
    },
    group: 'system',
    requiresApproval: false,
    isTransactional: false,
    accessesSensitiveData: true,
    isExternal: false,
    timeoutMs: 2_000,
  };

  const executor: ToolExecutor = async (input) => {
    const userPath = input.path as string;
    const maxBytes = typeof input.max_bytes === 'number' ? input.max_bytes : config.maxBytes;

    if (isAbsolute(userPath)) {
      return {
        content: 'ABSOLUTE_PATH_NOT_ALLOWED: only relative paths under FILE_ROOT are permitted',
        isError: true,
      };
    }

    const resolved = resolve(config.fileRoot, userPath);
    const rel = relative(config.fileRoot, resolved);
    if (rel.startsWith('..') || isAbsolute(rel)) {
      return {
        content: 'PATH_TRAVERSAL_BLOCKED: path escapes FILE_ROOT',
        isError: true,
      };
    }

    try {
      const real = await realpath(resolved);
      const realRel = relative(config.fileRoot, real);
      if (realRel.startsWith('..') || isAbsolute(realRel)) {
        return {
          content: 'SYMLINK_BLOCKED: symlink escapes FILE_ROOT',
          isError: true,
        };
      }

      const buf = await readFile(real);
      const truncated = buf.length > maxBytes;
      const content = buf.subarray(0, maxBytes).toString('utf-8');
      return {
        content: truncated
          ? `${content}\n\n[truncated at ${maxBytes} bytes of ${buf.length}]`
          : content,
        isError: false,
        metadata: { path: userPath, bytes: buf.length, truncated },
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        content: `read_local_file failed: ${message}`,
        isError: true,
      };
    }
  };

  registry.register(def, executor, 'skill');
}
