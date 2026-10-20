/**
 * Database dialect adapter.
 *
 * - DATABASE_URL = mysql://...        -> MySQL via mysql2 (production path, unchanged).
 * - DATABASE_URL unset / file: / sqlite: -> embedded SQLite via libsql (zero-config default).
 *
 * server/db.ts is written once against the MySQL-typed query builder. The SQLite schema
 * (drizzle/schema.sqlite.ts) mirrors it table for table, and the helpers below absorb the few
 * runtime differences (insert ids, affected rows, upserts, case-insensitive matching).
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { sql, type SQL, type AnyColumn } from "drizzle-orm";
import { drizzle as drizzleMysql } from "drizzle-orm/mysql2";
import { drizzle as drizzleLibsql } from "drizzle-orm/libsql";
import { migrate as migrateLibsql } from "drizzle-orm/libsql/migrator";
import { createClient, type Client } from "@libsql/client";
import * as mysqlSchema from "../../drizzle/schema";
import * as sqliteSchema from "../../drizzle/schema.sqlite";

export type Dialect = "mysql" | "sqlite";
export type MysqlDb = ReturnType<typeof drizzleMysql>;
export type Schema = typeof mysqlSchema;

export type DatabaseConfig =
  | { dialect: "mysql"; url: string }
  | { dialect: "sqlite"; path: string };

export type DbContext = {
  dialect: Dialect;
  /** Typed as the MySQL builder; at runtime it is the libsql builder when dialect is "sqlite". */
  db: MysqlDb;
  /** Tables of the active dialect (typed as MySQL tables). */
  s: Schema;
};

export const DEFAULT_SQLITE_RELATIVE_PATH = path.join("data", "ingrescan.db");

/** Pure function: decides dialect and file path from the environment. */
export function resolveDatabaseConfig(env: NodeJS.ProcessEnv = process.env): DatabaseConfig {
  const url = (env.DATABASE_URL ?? "").trim();
  if (url && !/^(file|sqlite):/i.test(url)) {
    return { dialect: "mysql", url };
  }
  let filePath: string;
  if (url) {
    // file:./x.db, file:/abs/x.db, file:///abs/x.db, sqlite:./x.db, sqlite:///abs/x.db
    let rest = url.replace(/^(file|sqlite):/i, "");
    if (rest.startsWith("//")) rest = rest.slice(2);
    try {
      rest = decodeURIComponent(rest);
    } catch {
      // ignore
    }
    if (/^\/[a-zA-Z]:/.test(rest)) {
      rest = rest.slice(1);
    }
    filePath = rest;
  } else {
    filePath = (env.SQLITE_PATH ?? "").trim() || DEFAULT_SQLITE_RELATIVE_PATH;
    try {
      filePath = decodeURIComponent(filePath);
    } catch {
      // ignore
    }
    if (/^\/[a-zA-Z]:/.test(filePath)) {
      filePath = filePath.slice(1);
    }
  }
  if (!filePath) filePath = DEFAULT_SQLITE_RELATIVE_PATH;

  let finalPath: string;
  if (filePath.startsWith("/")) {
    finalPath = filePath;
  } else if (/^[a-zA-Z]:[\\/]/.test(filePath)) {
    finalPath = filePath;
  } else {
    finalPath = path.resolve(process.cwd(), filePath);
  }

  return { dialect: "sqlite", path: finalPath };
}

function findMigrationsFolder(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(process.cwd(), "drizzle-sqlite"),
    path.resolve(here, "..", "drizzle-sqlite"),
    path.resolve(here, "..", "..", "drizzle-sqlite"),
  ];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "meta", "_journal.json"))) return c;
  }
  throw new Error(`SQLite migrations folder not found (looked in: ${candidates.join(", ")})`);
}

let _ctx: Promise<DbContext | null> | null = null;
let _client: Client | null = null;

async function openSqlite(filePath: string): Promise<DbContext> {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const client = createClient({ url: `file:${filePath}` });
  try {
    // Foreign keys are OFF by default in SQLite; ON DELETE CASCADE needs them.
    await client.execute("PRAGMA foreign_keys = ON");
    await client.execute("PRAGMA journal_mode = WAL");
    await client.execute("PRAGMA busy_timeout = 5000");
    const db = drizzleLibsql(client, { schema: sqliteSchema });
    await migrateLibsql(db, { migrationsFolder: findMigrationsFolder() });
    // The migrator may run inside a transaction that recycles the connection; re-assert the pragma.
    await client.execute("PRAGMA foreign_keys = ON");
    _client = client;
    console.log(`[Database] Using embedded SQLite database at ${filePath}`);
    return { dialect: "sqlite", db: db as unknown as MysqlDb, s: sqliteSchema as unknown as Schema };
  } catch (error) {
    try {
      client.close();
    } catch {
      // ignore
    }
    if (_client === client) {
      _client = null;
    }
    throw error;
  }
}

/**
 * Returns the active database context (opening and, for SQLite, migrating it on first use).
 * Returns null only when a MySQL connection could not be created.
 */
export function getDbContext(): Promise<DbContext | null> {
  if (!_ctx) {
    const config = resolveDatabaseConfig();
    if (config.dialect === "mysql") {
      try {
        _ctx = Promise.resolve({ dialect: "mysql" as const, db: drizzleMysql(config.url), s: mysqlSchema });
      } catch (error) {
        console.warn("[Database] Failed to connect:", error);
        return Promise.resolve(null); // not cached: retried on the next call, like before
      }
    } else {
      _ctx = openSqlite(config.path).catch(error => {
        _ctx = null;
        throw error;
      });
    }
  }
  return _ctx;
}

/** Eagerly open (and migrate) the database; call at server start to fail fast. */
export async function initDatabase(): Promise<void> {
  await getDbContext();
}

/** Close the embedded database and forget the cached context (used by tests). */
export async function closeDatabase(): Promise<void> {
  const pending = _ctx;
  _ctx = null;
  if (pending) await pending.catch(() => null);
  if (_client) {
    try {
      _client.close();
    } catch {
      // ignore
    }
    _client = null;
  }
}

// ---------- Dialect helpers ----------

/** Auto-increment id of a single-row insert. */
export function insertedId(ctx: DbContext, result: unknown): number {
  if (ctx.dialect === "mysql") return Number((result as [{ insertId: number }])[0].insertId);
  return Number((result as { lastInsertRowid?: bigint | number }).lastInsertRowid);
}

/** Rows touched by an UPDATE/DELETE. */
export function affectedRows(ctx: DbContext, result: unknown): number {
  if (ctx.dialect === "mysql") return Number((result as [{ affectedRows?: number }])[0].affectedRows ?? 0);
  return Number((result as { rowsAffected?: number }).rowsAffected ?? 0);
}

/**
 * Write result with the same observable shape on both dialects: `[{ insertId, affectedRows }]`.
 * MySQL returns the driver result untouched (it already has this shape).
 */
export function writeResult(ctx: DbContext, result: unknown) {
  if (ctx.dialect === "mysql") return result as [{ insertId: number; affectedRows: number }, unknown];
  return [{ insertId: insertedId(ctx, result), affectedRows: affectedRows(ctx, result) }] as const;
}

/**
 * Atomic single-statement upsert: INSERT ... ON DUPLICATE KEY UPDATE (MySQL) /
 * INSERT ... ON CONFLICT (target) DO UPDATE (SQLite). `target` is the unique column's property name.
 */
export async function upsertRow<T extends Record<string, unknown>>(
  ctx: DbContext,
  table: any,
  values: T,
  set: Record<string, unknown>,
  target: string
): Promise<void> {
  if (ctx.dialect === "mysql") {
    await (ctx.db.insert(table).values(values as any) as any).onDuplicateKeyUpdate({ set });
  } else {
    await (ctx.db.insert(table).values(values as any) as any).onConflictDoUpdate({
      target: table[target],
      set,
    });
  }
}

/** Equality that ignores case on SQLite, matching MySQL's default case-insensitive collation. */
export function eqInsensitive(ctx: DbContext, column: AnyColumn, value: string): SQL {
  return ctx.dialect === "sqlite" ? sql`${column} = ${value} COLLATE NOCASE` : sql`${column} = ${value}`;
}
