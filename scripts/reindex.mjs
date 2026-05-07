#!/usr/bin/env node
// scripts/reindex.mjs
// Phase 29 C10: 운영자 reindex CLI.
// 사용 예: pnpm tsx scripts/reindex.mjs --provider openai --dimension 1024 --dry-run
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
// 빌드된 dist 를 직접 참조 (scripts 는 workspace 멤버 아님). 사전 `pnpm build` 필요.
import { atomicReindex, createEmbeddingProvider } from '../packages/storage/dist/index.js';

const { values } = parseArgs({
  options: {
    provider: { type: 'string', default: 'auto' }, // 'voyage' | 'openai' | 'auto'
    dimension: { type: 'string', default: '1024' },
    'dry-run': { type: 'boolean', default: false },
    db: { type: 'string', default: join(homedir(), '.finclaw', 'db.sqlite') },
  },
});

const dimension = Number(values.dimension);
console.log(
  `[reindex] provider=${values.provider} dim=${dimension} db=${values.db} dry-run=${values['dry-run']}`,
);

if (values['dry-run']) {
  console.log('[reindex] dry-run - exiting');
  process.exit(0);
}

const provider = await createEmbeddingProvider(values.provider, { dimensions: dimension });
await atomicReindex(values.db, provider);
console.log('[reindex] done.');
