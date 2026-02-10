#!/usr/bin/env node
import { spawn } from 'node:child_process';

const runAll = process.argv.includes('--all');

/** @type {import('node:child_process').ChildProcess[]} */
const children = [];

function cleanup(signal) {
  for (const child of children) {
    child.kill(signal);
  }
}

process.on('SIGINT', () => { cleanup('SIGINT'); });
process.on('SIGTERM', () => { cleanup('SIGTERM'); });

/** @param {string} label @param {string[]} args */
function run(label, args) {
  return new Promise((resolve) => {
    const start = performance.now();
    const child = spawn('npx', ['vitest', 'run', ...args], {
      stdio: 'inherit',
      shell: true,
      env: {
        ...process.env,
        NODE_OPTIONS: [
          process.env.NODE_OPTIONS ?? '',
          '--disable-warning=ExperimentalWarning',
        ].filter(Boolean).join(' '),
      },
    });
    children.push(child);
    child.on('close', (code) => {
      children.splice(children.indexOf(child), 1);
      const elapsed = ((performance.now() - start) / 1000).toFixed(1);
      resolve({ label, code: code ?? 1, elapsed });
    });
  });
}

async function main() {
  const workers = process.env.FINCLAW_TEST_WORKERS;
  const workerArgs = workers ? ['--pool.forks.maxForks', workers, '--pool.forks.minForks', workers] : [];

  console.log('--- Phase 1: unit + storage (parallel) ---\n');

  const phase1 = await Promise.all([
    run('unit', [...workerArgs]),
    run('storage', ['--config', 'vitest.storage.config.ts', ...workerArgs]),
  ]);

  const results = [...phase1];

  if (runAll) {
    console.log('\n--- Phase 2: e2e (sequential) ---\n');
    const e2e = await run('e2e', ['--config', 'vitest.e2e.config.ts', ...workerArgs]);
    results.push(e2e);
  }

  console.log('\n========== Summary ==========');
  let failed = false;
  for (const r of results) {
    const status = r.code === 0 ? 'PASS' : 'FAIL';
    if (r.code !== 0) failed = true;
    console.log(`  ${status}  ${r.label.padEnd(10)} ${r.elapsed}s`);
  }
  console.log('=============================\n');

  process.exit(failed ? 1 : 0);
}

main();
