/**
 * Neon (agent backend). Pooled DATABASE_URL for app traffic.
 *
 * `db` is a PROXY, not a fixed handle. By default it resolves to the pool for
 * DATABASE_URL — the project's `main` branch. Inside `withBranchDb(url, fn)` it
 * resolves, for that async context only, to a pool on another Neon branch. That
 * is what makes "fork this mission" possible without threading a db handle
 * through every agent: the whole pipeline (Scout, Curator, Architect, Judge,
 * the event sink, setMissionStatus) keeps importing `db` from "@/db" and writes
 * land on whichever branch the caller bound.
 *
 * The training sandboxes write to Neon themselves, so daytona.ts asks
 * `activeDatabaseUrl()` for the URL it hands them — a fork's runs, policies and
 * artifacts land on the fork's branch too, not on main.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

const connectionString =
  process.env.DATABASE_URL ?? (() => { throw new Error("DATABASE_URL is not set"); })();

type Db = NodePgDatabase<typeof schema>;

const globalForDb = globalThis as unknown as {
  __furrowPool?: Pool;
  __furrowBranchPools?: Map<string, { pool: Pool; db: Db }>;
  __furrowDbCtx?: AsyncLocalStorage<{ url: string; db: Db }>;
};

const pool = globalForDb.__furrowPool ?? new Pool({ connectionString, max: 8 });
if (process.env.NODE_ENV !== "production") globalForDb.__furrowPool = pool;

const mainDb: Db = drizzle(pool, { schema });

/** Survives HMR: a branch pool opened by one module instance stays usable. */
const branchPools =
  globalForDb.__furrowBranchPools ?? (globalForDb.__furrowBranchPools = new Map());
const ctx =
  globalForDb.__furrowDbCtx ?? (globalForDb.__furrowDbCtx = new AsyncLocalStorage());

function branchDb(url: string): Db {
  const hit = branchPools.get(url);
  if (hit) return hit.db;
  // Small: a fork re-run is one mission, and the branch is short-lived.
  const p = new Pool({ connectionString: url, max: 4 });
  const d = drizzle(p, { schema });
  branchPools.set(url, { pool: p, db: d });
  return d;
}

function current(): Db {
  return ctx.getStore()?.db ?? mainDb;
}

/**
 * Run `fn` with every `db` read/write in its async context pointed at `url`
 * (a Neon branch connection string). Nested calls replace the binding.
 */
export function withBranchDb<T>(url: string, fn: () => Promise<T>): Promise<T> {
  return ctx.run({ url, db: branchDb(url) }, fn);
}

/** The connection string the current async context writes to. */
export function activeDatabaseUrl(): string {
  return ctx.getStore()?.url ?? connectionString;
}

/** True when the caller is inside a fork branch's context. */
export function onBranch(): boolean {
  return Boolean(ctx.getStore());
}

/**
 * A short, non-secret label for the branch this context writes to ("main", or
 * 8 hex of the connection string). Safe to use as a map key or in a log line;
 * the connection string itself never is, because it carries a password.
 */
export function activeDbTag(): string {
  const url = ctx.getStore()?.url;
  if (!url) return "main";
  return "br-" + createHash("sha256").update(url).digest("hex").slice(0, 8);
}

/** Release a branch pool once its fork is finished with (or deleted). */
export async function closeBranchDb(url: string): Promise<void> {
  const hit = branchPools.get(url);
  if (!hit) return;
  branchPools.delete(url);
  await hit.pool.end().catch(() => {});
}

/**
 * The handle every caller imports. Methods are bound to whichever drizzle
 * instance is active in this async context (see withBranchDb).
 */
export const db: Db = new Proxy({} as Db, {
  get(_t, prop, _recv) {
    const target = current() as unknown as Record<string | symbol, unknown>;
    const v = target[prop];
    return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
  },
  has(_t, prop) {
    return prop in (current() as unknown as object);
  },
}) as Db;

export { schema };

/** Replay mode reads state from the frozen demo-golden branch (§1). */
export function demoDb() {
  const url = process.env.DATABASE_URL_DEMO;
  if (!url) return db;
  const g = globalThis as unknown as { __furrowDemoPool?: Pool };
  const p = g.__furrowDemoPool ?? new Pool({ connectionString: url, max: 4 });
  g.__furrowDemoPool = p;
  return drizzle(p, { schema });
}
