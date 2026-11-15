/**
 * Mastra instance (CLAUDE.md §3.1, MLH Mastra track).
 * Memory and workflow snapshots live in Neon under the `mastra` schema, so the
 * agent backend and the mission state sit in the same database.
 */
import { Mastra } from "@mastra/core";
import { PostgresStore } from "@mastra/pg";

let store: PostgresStore | null = null;

export function mastraStore(): PostgresStore | null {
  if (!process.env.DATABASE_URL) return null;
  if (!store) {
    store = new PostgresStore({
      id: "furrow",
      connectionString: process.env.DATABASE_URL,
      schemaName: "mastra",
    });
  }
  return store;
}

const g = globalThis as unknown as { __furrowMastra?: Mastra };

export function mastra(): Mastra {
  if (!g.__furrowMastra) {
    const s = mastraStore();
    g.__furrowMastra = new Mastra(s ? { storage: s } : {});
  }
  return g.__furrowMastra;
}
