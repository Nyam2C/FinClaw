import type { PluginManifest } from '@finclaw/types';
// packages/server/src/plugins/manifest.ts
import { z } from 'zod/v4';

/** 플러그인 매니페스트 Zod v4 스키마 */
export const PluginManifestSchema = z.strictObject({
  name: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+/),
  description: z.string().optional(),
  author: z.string().optional(),
  main: z.string().min(1),
  type: z.enum(['channel', 'skill', 'tool', 'service']),
  dependencies: z.array(z.string()).optional(),
  slots: z.array(z.string()).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  configSchema: z.unknown().optional(),
});

/** Zod v4 매니페스트 파싱 — 성공 시 PluginManifest 반환 */
export function parseManifest(
  raw: unknown,
): { ok: true; manifest: PluginManifest } | { ok: false; error: string } {
  const result = PluginManifestSchema.safeParse(raw);
  if (result.success) {
    return { ok: true, manifest: result.data as PluginManifest };
  }
  const tree = z.treeifyError(result.error);
  return { ok: false, error: formatTreeErrors(tree) };
}

/** JSON Schema 자동 생성 (Phase 7 Tool System 활용) */
export const manifestJsonSchema = z.toJSONSchema(PluginManifestSchema, {
  target: 'draft-2020-12',
});

/** z.treeifyError 결과를 단일 문자열로 평탄화 */
function formatTreeErrors(tree: z.core.$ZodErrorTree<Record<string, unknown>>, path = ''): string {
  const messages: string[] = [];

  if (tree.errors && tree.errors.length > 0) {
    for (const msg of tree.errors) {
      messages.push(path ? `${path}: ${msg}` : msg);
    }
  }

  if (tree.properties) {
    for (const [key, subtree] of Object.entries(tree.properties)) {
      const childPath = path ? `${path}.${key}` : key;
      messages.push(
        formatTreeErrors(subtree as z.core.$ZodErrorTree<Record<string, unknown>>, childPath),
      );
    }
  }

  return messages.filter(Boolean).join('; ');
}
