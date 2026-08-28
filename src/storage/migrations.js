/**
 * Ordered SQLite migration runner.
 *
 * - Tracks applied migrations in schema_migrations (id, checksum, applied_at)
 * - Refuses checksum drift on already-applied migrations
 * - Supports status/dry-run via options
 * - Does not drop legacy tables
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_MIGRATIONS_DIR = resolve(__dirname, 'migrations');

function sha256(text) {
  return createHash('sha256').update(String(text)).digest('hex');
}

function listMigrationFiles(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => /^\d+_.*\.(sql|js)$/.test(name))
    .sort((a, b) => a.localeCompare(b));
}

export function ensureMigrationsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
}

export function listAppliedMigrations(db) {
  ensureMigrationsTable(db);
  return db
    .prepare('SELECT id, checksum, applied_at FROM schema_migrations ORDER BY id')
    .all();
}

export function loadMigrations(dir = DEFAULT_MIGRATIONS_DIR) {
  return listMigrationFiles(dir).map((fileName) => {
    const fullPath = join(dir, fileName);
    const id = basename(fileName).replace(/\.(sql|js)$/, '');
    if (fileName.endsWith('.sql')) {
      const sql = readFileSync(fullPath, 'utf8');
      return {
        id,
        fileName,
        checksum: sha256(sql),
        kind: 'sql',
        sql
      };
    }
    return {
      id,
      fileName,
      checksum: sha256(readFileSync(fullPath, 'utf8')),
      kind: 'js',
      fullPath
    };
  });
}

/**
 * Apply pending migrations.
 * @param {import('better-sqlite3').Database} db
 * @param {{ dir?: string, dryRun?: boolean }} [options]
 */
export function applyMigrations(db, options = {}) {
  const dir = options.dir || DEFAULT_MIGRATIONS_DIR;
  const dryRun = Boolean(options.dryRun);
  ensureMigrationsTable(db);

  const applied = listAppliedMigrations(db);
  const appliedMap = new Map(applied.map((row) => [row.id, row]));
  const migrations = loadMigrations(dir);
  const pending = [];
  const skipped = [];

  for (const migration of migrations) {
    const existing = appliedMap.get(migration.id);
    if (existing) {
      if (existing.checksum !== migration.checksum) {
        throw new Error(
          `Migration checksum drift for ${migration.id}: stored=${existing.checksum} current=${migration.checksum}`
        );
      }
      skipped.push(migration.id);
      continue;
    }
    pending.push(migration);
  }

  if (dryRun) {
    return {
      dryRun: true,
      applied: applied.map((r) => r.id),
      pending: pending.map((m) => m.id),
      skipped
    };
  }

  const appliedNow = [];
  for (const migration of pending) {
    const run = db.transaction(() => {
      // Concurrent processes (parallel test files on a fresh DB) can both see
      // the migration as pending; the write lock serializes them, so re-check
      // under the lock and skip if another process applied it meanwhile.
      const existing = db
        .prepare('SELECT checksum FROM schema_migrations WHERE id = ?')
        .get(migration.id);
      if (existing) {
        if (existing.checksum !== migration.checksum) {
          throw new Error(
            `Migration checksum drift for ${migration.id}: stored=${existing.checksum} current=${migration.checksum}`
          );
        }
        return false;
      }
      if (migration.kind === 'sql') {
        db.exec(migration.sql);
      } else {
        throw new Error(`JS migrations not executed inline: ${migration.id}`);
      }
      db.prepare(
        `INSERT INTO schema_migrations (id, checksum, applied_at) VALUES (?, ?, ?)`
      ).run(migration.id, migration.checksum, new Date().toISOString());
      return true;
    });
    // BEGIN IMMEDIATE takes the write lock up front so the re-check is
    // race-free (deferred BEGIN would only lock at first write).
    if (run.immediate()) {
      appliedNow.push(migration.id);
    } else {
      skipped.push(migration.id);
    }
  }

  return {
    dryRun: false,
    applied: appliedNow,
    pending: [],
    skipped,
    allApplied: listAppliedMigrations(db).map((r) => r.id)
  };
}

export function migrationStatus(db, dir = DEFAULT_MIGRATIONS_DIR) {
  return applyMigrations(db, { dir, dryRun: true });
}
