import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

import Database from 'better-sqlite3';

import { Storage } from '../src/storage.js';

const TMP_DIR = resolve(process.cwd(), '.tmp-migrations-concurrent-tests');

function freshStatePath() {
  mkdirSync(TMP_DIR, { recursive: true });
  return resolve(TMP_DIR, `state-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

test('re-opening storage on the same db re-applies no migrations', () => {
  const statePath = freshStatePath();
  const first = new Storage(statePath);
  first.close?.();
  // Second open must treat every migration as already applied (idempotent).
  const second = new Storage(statePath);
  const dupes = second.db
    .prepare('SELECT id, COUNT(*) AS n FROM schema_migrations GROUP BY id HAVING n > 1')
    .all();
  assert.deepEqual(dupes, [], 'no duplicate schema_migrations rows');
  second.close?.();
});

test('two processes opening storage on the same fresh db do not collide', () => {
  // Regression: parallel test files each construct Storage() against a fresh
  // DB; both saw every migration as pending and the loser crashed with
  // "UNIQUE constraint failed: schema_migrations.id". The apply loop now
  // re-checks under an IMMEDIATE write lock and skips already-applied rows.
  const statePath = freshStatePath();
  const script = `
    import { Storage } from ${JSON.stringify(resolve(process.cwd(), 'src/storage.js'))};
    const storage = new Storage(process.argv[1]);
    storage.close?.();
  `;
  for (let i = 0; i < 2; i += 1) {
    execFileSync(process.execPath, ['--input-type=module', '-e', script, statePath], {
      stdio: 'pipe',
      env: { ...process.env, NODE_ENV: 'test' }
    });
  }
  const dbPath = statePath.replace(/\.json$/, '.sqlite');
  const db = new Database(dbPath, { readonly: true });
  const dupes = db
    .prepare('SELECT id, COUNT(*) AS n FROM schema_migrations GROUP BY id HAVING n > 1')
    .all();
  assert.deepEqual(dupes, [], 'no duplicate schema_migrations rows');
  db.close();
});

test.after(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});
