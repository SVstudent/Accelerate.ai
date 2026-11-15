/**
 * Neon control-plane client — the one thing no other Postgres host can do.
 *
 * Used by "fork this mission": branch the database at a finished mission's
 * state, re-run one stage of the pipeline against the branch with different
 * parameters, and compare the two timelines. The branch is copy-on-write, so
 * the fork starts with every scraped source, cited fact, curated image,
 * perception model and binary artifact already present — nothing is re-scraped
 * and nothing is copied.
 *
 * Safety rules enforced HERE, not at the call sites:
 *  · `main` and `demo-golden` (the pinned demo replay) can never be deleted;
 *  · a branch Neon reports as default or protected can never be deleted;
 *  · branch names Furrow creates are prefixed `furrow-fork-` so a cleanup pass
 *    can tell our branches from a human's.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

const API = process.env.NEON_API_BASE ?? "https://console.neon.tech/api/v2";

/** Never deletable, by name, whatever the caller passes. */
export const PROTECTED_BRANCH_NAMES = new Set(["main", "demo-golden"]);
/** Never deletable, by id: the pinned demo replay branch. */
export const PROTECTED_BRANCH_IDS = new Set(["br-plain-dawn-bbo54zme"]);
/** Every branch Furrow creates starts with this. */
export const FORK_PREFIX = "furrow-fork-";

/**
 * Two transports, in this order:
 *  1. NEON_API_KEY — a project API key. This is the one to deploy with;
 *     create it once with `neon api-keys create --name furrow` and put it in
 *     .env.local.
 *  2. the `neon` CLI's authenticated passthrough (`neon api <path>`), used
 *     when no key is set. It works on a developer machine that is already
 *     logged in (`neon auth`), which is how this feature can be demonstrated
 *     without minting a key, and it is deliberately opt-out-able with
 *     NEON_CLI_FALLBACK=false.
 */
export function neonConfigured(): boolean {
  return Boolean(process.env.NEON_API_KEY) || cliFallbackEnabled();
}

export function cliFallbackEnabled(): boolean {
  return (process.env.NEON_CLI_FALLBACK ?? "true") !== "false";
}

export function neonTransport(): "api_key" | "cli" | "none" {
  if (process.env.NEON_API_KEY) return "api_key";
  return cliFallbackEnabled() ? "cli" : "none";
}

let cachedProject: string | null = null;
/** Project id from the env, falling back to the repo's `.neon` context file. */
export function neonProjectId(): string {
  if (cachedProject) return cachedProject;
  const fromEnv = process.env.NEON_PROJECT_ID;
  if (fromEnv) return (cachedProject = fromEnv);
  for (const p of [
    join(process.cwd(), ".neon"),
    join(process.cwd(), "..", "..", ".neon"),
  ]) {
    try {
      const j = JSON.parse(readFileSync(p, "utf8")) as { projectId?: string };
      if (j.projectId) return (cachedProject = j.projectId);
    } catch { /* try the next location */ }
  }
  throw new Error("NEON_PROJECT_ID is not set and no .neon context file was found");
}

/** `neon api` passthrough: same REST path, the developer's own credentials. */
async function cliApi<T>(path: string, init: RequestInit = {}): Promise<T> {
  const args = [
    "api", path,
    "-X", String(init.method ?? "GET"),
    ...(init.body ? ["-d", String(init.body)] : []),
  ];
  try {
    const { stdout } = await exec("neon", args, {
      timeout: 60_000, maxBuffer: 8 * 1024 * 1024,
    });
    const text = stdout.trim();
    return (text ? JSON.parse(text) : {}) as T;
  } catch (err) {
    const e = err as { stderr?: string; message?: string };
    throw new Error(
      `neon cli ${init.method ?? "GET"} ${path} failed: ` +
      `${(e.stderr ?? e.message ?? "").slice(0, 200)} ` +
      `(set NEON_API_KEY to use the HTTP API instead)`,
    );
  }
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const key = process.env.NEON_API_KEY;
  if (!key) {
    if (!cliFallbackEnabled()) throw new Error("NEON_API_KEY is not set");
    return await cliApi<T>(path, init);
  }
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
      accept: "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    // never echo the body wholesale: it can contain a connection URI
    throw new Error(`neon api ${init.method ?? "GET"} ${path} → ${res.status} ${text.slice(0, 200)}`);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

export type NeonBranch = {
  id: string;
  name: string;
  parent_id?: string;
  created_at?: string;
  updated_at?: string;
  default?: boolean;
  protected?: boolean;
  current_state?: string;
  logical_size?: number;
};

export async function listBranches(): Promise<NeonBranch[]> {
  const out = await api<{ branches: NeonBranch[] }>(
    `/projects/${neonProjectId()}/branches`,
  );
  return out.branches ?? [];
}

export async function getBranch(branchId: string): Promise<NeonBranch | null> {
  try {
    const out = await api<{ branch: NeonBranch }>(
      `/projects/${neonProjectId()}/branches/${branchId}`,
    );
    return out.branch ?? null;
  } catch {
    return null;
  }
}

/** role / database the app itself connects with, parsed from DATABASE_URL. */
export function connectionIdentity(): { role: string; database: string } {
  const url = process.env.DATABASE_URL_UNPOOLED ?? process.env.DATABASE_URL ?? "";
  try {
    const u = new URL(url);
    return {
      role: decodeURIComponent(u.username || "neondb_owner"),
      database: (u.pathname || "/neondb").replace(/^\//, "").split("?")[0] || "neondb",
    };
  } catch {
    return { role: "neondb_owner", database: "neondb" };
  }
}

/**
 * Create a branch of `parentId` (default: the project's default branch) with a
 * read-write endpoint, and return its pooled connection string.
 *
 * The returned URI contains a password — it is written to nothing but the
 * process that runs the fork, and never into a log or an event payload.
 */
export async function createForkBranch(opts: {
  name: string;
  parentId?: string;
  /** Branch at this LSN/timestamp instead of "now" (optional). */
  parentTimestamp?: string;
}): Promise<{ branch: NeonBranch; connectionUri: string }> {
  const { role, database } = connectionIdentity();
  const name = opts.name.startsWith(FORK_PREFIX) ? opts.name : `${FORK_PREFIX}${opts.name}`;
  const out = await api<{
    branch: NeonBranch;
    connection_uris?: { connection_uri: string }[];
  }>(`/projects/${neonProjectId()}/branches`, {
    method: "POST",
    body: JSON.stringify({
      branch: {
        name,
        ...(opts.parentId ? { parent_id: opts.parentId } : {}),
        ...(opts.parentTimestamp ? { parent_timestamp: opts.parentTimestamp } : {}),
      },
      endpoints: [{ type: "read_write" }],
    }),
  });
  const branch = out.branch;
  if (!branch?.id) throw new Error("neon api did not return a branch id");
  const uri =
    out.connection_uris?.[0]?.connection_uri ??
    (await connectionUri(branch.id, { role, database }));
  if (!uri) throw new Error(`branch ${branch.id} created but no connection URI was returned`);
  return { branch, connectionUri: uri };
}

export async function connectionUri(
  branchId: string,
  opts?: { role?: string; database?: string; pooled?: boolean },
): Promise<string> {
  const id = connectionIdentity();
  const q = new URLSearchParams({
    branch_id: branchId,
    database_name: opts?.database ?? id.database,
    role_name: opts?.role ?? id.role,
    pooled: String(opts?.pooled ?? true),
  });
  const out = await api<{ uri: string }>(
    `/projects/${neonProjectId()}/connection_uri?${q.toString()}`,
  );
  return out.uri;
}

export function isProtectedBranch(b: Pick<NeonBranch, "id" | "name" | "default" | "protected">): boolean {
  return Boolean(
    b.default || b.protected ||
    PROTECTED_BRANCH_NAMES.has(b.name) || PROTECTED_BRANCH_IDS.has(b.id),
  );
}

/**
 * Delete a branch. Refuses `main`, `demo-golden`, and anything Neon marks
 * default or protected — the guard is here so no caller can bypass it.
 */
export async function deleteBranch(branchId: string): Promise<{ deleted: boolean; reason?: string }> {
  if (PROTECTED_BRANCH_IDS.has(branchId)) {
    return { deleted: false, reason: `${branchId} is a protected branch` };
  }
  const b = await getBranch(branchId);
  if (!b) return { deleted: false, reason: "branch not found" };
  if (isProtectedBranch(b)) {
    return { deleted: false, reason: `${b.name} is protected and cannot be deleted` };
  }
  await api(`/projects/${neonProjectId()}/branches/${branchId}`, { method: "DELETE" });
  return { deleted: true };
}
