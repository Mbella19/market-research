import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { chmodSync, existsSync } from "node:fs";
import { DATA_DIR } from "./lib/env.ts";

export const db = new DatabaseSync(join(DATA_DIR, "lodestone.db"));
for (const suffix of ["", "-wal", "-shm"]) {
  const path = join(DATA_DIR, `lodestone.db${suffix}`);
  if (existsSync(path)) {
    try {
      chmodSync(path, 0o600);
    } catch {
      /* best effort on non-POSIX filesystems */
    }
  }
}

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS scans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  topic TEXT,
  mode TEXT NOT NULL DEFAULT 'topic',
  depth TEXT NOT NULL DEFAULT 'standard',
  sources_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'running',
  stage TEXT NOT NULL DEFAULT 'plan',
  plan_json TEXT,
  progress_json TEXT,
  error TEXT,
  ai_mode TEXT NOT NULL DEFAULT 'ai',
  created_at INTEGER NOT NULL,
  finished_at INTEGER
);

CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scan_id INTEGER NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  author_hash TEXT,
  score INTEGER NOT NULL DEFAULT 0,
  comments INTEGER NOT NULL DEFAULT 0,
  views INTEGER,
  created_utc INTEGER,
  meta_json TEXT,
  hash TEXT NOT NULL,
  UNIQUE(scan_id, hash)
);
CREATE INDEX IF NOT EXISTS idx_items_scan ON items(scan_id);

CREATE TABLE IF NOT EXISTS problems (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scan_id INTEGER NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  statement TEXT NOT NULL,
  category TEXT,
  persona TEXT,
  severity INTEGER NOT NULL DEFAULT 3,
  wtp TEXT NOT NULL DEFAULT 'none',
  quote TEXT,
  quote_verified INTEGER NOT NULL DEFAULT 0,
  engine TEXT NOT NULL DEFAULT 'ai'
);
CREATE INDEX IF NOT EXISTS idx_problems_scan ON problems(scan_id);

CREATE TABLE IF NOT EXISTS clusters (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scan_id INTEGER NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  summary TEXT,
  category TEXT,
  persona TEXT,
  distinct_authors INTEGER NOT NULL DEFAULT 0,
  platforms INTEGER NOT NULL DEFAULT 0,
  platform_list_json TEXT,
  engagement INTEGER NOT NULL DEFAULT 0,
  voices INTEGER NOT NULL DEFAULT 0,
  recency_ratio REAL NOT NULL DEFAULT 0,
  dated_ratio REAL NOT NULL DEFAULT 0,
  growth_rate REAL NOT NULL DEFAULT 0,
  evidence_items INTEGER NOT NULL DEFAULT 0,
  metrics_version INTEGER NOT NULL DEFAULT 1,
  timeline_json TEXT,
  demand_score REAL NOT NULL DEFAULT 0,
  tier TEXT NOT NULL DEFAULT 'insufficient',
  validated INTEGER NOT NULL DEFAULT 0,
  gate_json TEXT,
  judge_json TEXT,
  engine TEXT NOT NULL DEFAULT 'ai'
);
CREATE INDEX IF NOT EXISTS idx_clusters_scan ON clusters(scan_id);

CREATE TABLE IF NOT EXISTS cluster_problems (
  cluster_id INTEGER NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
  problem_id INTEGER NOT NULL REFERENCES problems(id) ON DELETE CASCADE,
  PRIMARY KEY (cluster_id, problem_id)
);

CREATE TABLE IF NOT EXISTS opportunities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scan_id INTEGER NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  cluster_id INTEGER NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  one_liner TEXT,
  brief_md TEXT NOT NULL,
  brief_json TEXT,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_opportunities_cluster ON opportunities(cluster_id);

CREATE TABLE IF NOT EXISTS trends (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scan_id INTEGER NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'early',
  momentum_score REAL NOT NULL DEFAULT 0,
  software_fit TEXT NOT NULL DEFAULT 'possible',
  fit_reason TEXT NOT NULL DEFAULT '',
  signals_json TEXT NOT NULL DEFAULT '[]',
  angles_md TEXT,
  engine TEXT NOT NULL DEFAULT 'ai',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trends_scan ON trends(scan_id);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  scan_id INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  data_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_scan ON events(scan_id);
CREATE TRIGGER IF NOT EXISTS delete_scan_events
AFTER DELETE ON scans BEGIN DELETE FROM events WHERE scan_id=OLD.id; END;

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS http_cache (
  key TEXT PRIMARY KEY,
  url TEXT NOT NULL,
  status INTEGER NOT NULL,
  body TEXT NOT NULL,
  ts INTEGER NOT NULL
);
`);

// Explicit additive migrations. Unexpected migration failures must stop startup.
function addColumn(table: string, ddl: string): void {
  const column = ddl.trim().split(/\s+/, 1)[0]!;
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (columns.some((entry) => entry.name === column)) return;
  db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}
addColumn("clusters", "paid_intent_json TEXT");
addColumn("clusters", "dated_ratio REAL NOT NULL DEFAULT 0");
addColumn("clusters", "growth_rate REAL NOT NULL DEFAULT 0");
addColumn("clusters", "evidence_items INTEGER NOT NULL DEFAULT 0");
addColumn("clusters", "metrics_version INTEGER NOT NULL DEFAULT 1");
addColumn("scans", "config_json TEXT");
addColumn("scans", "pipeline_version INTEGER NOT NULL DEFAULT 1");
addColumn("scans", "parent_scan_id INTEGER");
addColumn("trends", "source_count INTEGER NOT NULL DEFAULT 1");
addColumn("trends", "signal_strength REAL NOT NULL DEFAULT 0");
addColumn("trends", "metrics_version INTEGER NOT NULL DEFAULT 1");

db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_opportunities_cluster ON opportunities(cluster_id)");
db.prepare("DELETE FROM http_cache WHERE ts < ?").run(Date.now() - 7 * 86400_000);
db.exec(`DELETE FROM http_cache WHERE key NOT IN (SELECT key FROM http_cache ORDER BY ts DESC LIMIT 250)`);

export type Row = Record<string, unknown>;

export function all<T = Row>(sql: string, ...params: unknown[]): T[] {
  return db.prepare(sql).all(...(params as never[])) as T[];
}

export function get<T = Row>(sql: string, ...params: unknown[]): T | undefined {
  return db.prepare(sql).get(...(params as never[])) as T | undefined;
}

export function run(sql: string, ...params: unknown[]): { changes: number; lastId: number } {
  const r = db.prepare(sql).run(...(params as never[]));
  return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) };
}

/** Execute synchronous DB work atomically. Nested transactions are intentionally unsupported. */
export function transaction<T>(fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* preserve the original failure */
    }
    throw error;
  }
}

export function closeDatabase(): void {
  db.close();
}

export function jsonOrNull<T>(s: unknown): T | null {
  if (typeof s !== "string" || !s) return null;
  try {
    return JSON.parse(s) as T;
  } catch {
    return null;
  }
}
