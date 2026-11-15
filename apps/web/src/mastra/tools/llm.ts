/**
 * Model providers.
 *  · Agent LLM  → Vultr Serverless Inference (OpenAI-compatible). CLAUDE.md §3.1.
 *  · Vision QA  → TokenRouter (OpenAI-compatible gateway) fronting Gemini.
 * Both speak the same wire format, so they share one adapter.
 */
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

const VULTR_BASE = "https://api.vultrinference.com/v1";

/**
 * Every model call gets a deadline. Without one a stalled connection blocks the
 * whole mission: a real run sat in `designing` for 7+ minutes with no error and
 * no sandbox, because generateText never returned and the Architect's
 * deterministic fallback never got a chance to run.
 */
export const LLM_TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS ?? 90_000);

function deadline(): AbortSignal {
  return AbortSignal.timeout(LLM_TIMEOUT_MS);
}

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set (see .env.local)`);
  return v;
}

/* ── Vultr: every agent LLM call ──────────────────────────────────────── */
export const vultr = createOpenAICompatible({
  name: "vultr",
  baseURL: process.env.VULTR_BASE_URL ?? VULTR_BASE,
  apiKey: process.env.VULTR_INFERENCE_API_KEY ?? "",
});

/** Primary model. Tool-calling verified: glm-5.3. */
export function agentModel() {
  return vultr(process.env.VULTR_MODEL ?? "glm-5.3");
}

/** Fallback model id for retry-on-failure (§8 step 4). */
export function fallbackModel() {
  return vultr(process.env.VULTR_MODEL_FALLBACK ?? "deepseek-v4.1-flash-1017");
}

/**
 * Run an LLM call on the primary model, retrying once on the fallback.
 * Vultr occasionally drops a model; the demo must not die with it.
 */
export async function withModelFallback<T>(
  fn: (model: ReturnType<typeof agentModel>) => Promise<T>,
): Promise<T> {
  try {
    return await fn(agentModel());
  } catch (err) {
    console.warn("[llm] primary model failed, retrying on fallback:", (err as Error).message);
    return await fn(fallbackModel());
  }
}

/* ── TokenRouter: vision QA (Gemini) ─────────────────────────────────── */
export function visionProvider() {
  const provider = process.env.VISION_PROVIDER ?? "tokenrouter";
  if (provider !== "tokenrouter") return null;
  const baseURL = need("TOKENROUTER_BASE_URL");
  return createOpenAICompatible({
    name: "tokenrouter",
    baseURL,
    apiKey: need("TOKENROUTER_API_KEY"),
  });
}

export function visionModel() {
  const p = visionProvider();
  if (!p) return null;
  return p(need("TOKENROUTER_VISION_MODEL"));
}

export function visionConfigured(): boolean {
  return Boolean(
    process.env.TOKENROUTER_API_KEY &&
    process.env.TOKENROUTER_BASE_URL &&
    process.env.TOKENROUTER_VISION_MODEL,
  );
}

export function llmConfigured(): boolean {
  return Boolean(process.env.VULTR_INFERENCE_API_KEY);
}

/* ── structured output ────────────────────────────────────────────────── */

import { generateObject, generateText, jsonSchema, tool, type ToolSet } from "ai";
import { z } from "zod";

/**
 * Tool parameters as plain JSON Schema with `$schema` removed.
 * Gemini (through TokenRouter) rejects the key outright:
 *   Unknown name "$schema" at 'tools[0].function_declarations[0].parameters'
 */
function toolParams(schema: z.ZodType<unknown>) {
  try {
    const js = z.toJSONSchema(schema, { target: "draft-7", io: "input" }) as Record<string, unknown>;
    delete js.$schema;
    return jsonSchema(js as Parameters<typeof jsonSchema>[0]);
  } catch {
    return undefined;   // fall back to the zod schema below
  }
}

/**
 * Reliable structured output across providers.
 *
 * Measured on Vultr (2026-11-14): glm-5.3 and friends DO support tool calling
 * but reject JSON-schema response_format, so `generateObject` fails with
 * "response did not match schema". Tool calling is therefore the primary path;
 * generateObject and a last-ditch JSON-in-text parse are the fallbacks.
 */
export async function structured<T>(opts: {
  schema: z.ZodType<T>;
  instructions: string;
  prompt: string;
  name?: string;
  description?: string;
  maxRetries?: number;
  /** data: or https: image URLs to attach to the user turn (vision QA). */
  images?: string[];
  /** Override the provider — vision goes to TokenRouter, agents to Vultr. */
  model?: ReturnType<typeof agentModel>;
  /**
   * Which path to try first. Vultr does tool calling well; the Gemini gateway
   * rejects tool JSON Schema but answers plain-JSON reliably, so vision passes
   * "text".
   */
  prefer?: "tool" | "text";
}): Promise<T> {
  const name = opts.name ?? "submit";
  const description = opts.description ?? "Submit the structured result.";

  // multimodal user turn when images are attached
  const userMessage = opts.images?.length
    ? [{
        role: "user" as const,
        content: [
          { type: "text" as const, text: opts.prompt },
          ...opts.images.map((u) => ({ type: "image" as const, image: new URL(u) })),
        ],
      }]
    : undefined;

  const runWith = async <R>(fn: (m: ReturnType<typeof agentModel>) => Promise<R>): Promise<R> =>
    opts.model ? fn(opts.model) : withModelFallback(fn);

  const textPath = async (): Promise<T> => runWith(async (model) => {
    const res = await generateText({
      model,
      instructions: `${opts.instructions}\n\nReply with ONLY a JSON object matching the requested fields. No prose, no code fences.`,
      ...(userMessage ? { messages: userMessage } : { prompt: opts.prompt }),
      abortSignal: deadline(),
    });
    const text = res.text ?? "";
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end <= start) throw new Error(`no JSON in reply: ${text.slice(0, 160)}`);
    return opts.schema.parse(JSON.parse(text.slice(start, end + 1)));
  });

  if (opts.prefer === "text") {
    try {
      return await textPath();
    } catch (err) {
      console.warn("[llm] text path failed:", (err as Error).message);
    }
  }

  // 1. tool calling — verified working on Vultr
  try {
    return await runWith(async (model) => {
      const params = toolParams(opts.schema as z.ZodType<unknown>);
      const tools = {
        [name]: tool({
          description,
          inputSchema: params ?? (opts.schema as unknown as z.ZodType<Record<string, unknown>>),
        }),
      } as unknown as ToolSet;
      const res = await generateText({
        model,
        instructions: opts.instructions,
        ...(userMessage ? { messages: userMessage } : { prompt: opts.prompt }),
        tools,
        toolChoice: "required",
        maxRetries: opts.maxRetries ?? 1,
        abortSignal: deadline(),
      });
      const call = res.toolCalls?.[0];
      if (!call) throw new Error("model returned no tool call");
      const input = (call as unknown as { input?: unknown; args?: unknown }).input
        ?? (call as unknown as { args?: unknown }).args;
      return opts.schema.parse(input);
    });
  } catch (toolErr) {
    console.warn("[llm] tool-call path failed:", (toolErr as Error).message);
  }

  // 2. native structured output, for providers that do support it
  try {
    return await runWith(async (model) => {
      const { object } = await generateObject({
        model, schema: opts.schema, instructions: opts.instructions,
        ...(userMessage ? { messages: userMessage } : { prompt: opts.prompt }),
        abortSignal: deadline(),
      });
      return object as T;
    });
  } catch (objErr) {
    console.warn("[llm] generateObject path failed:", (objErr as Error).message);
  }

  // 3. plain text, then parse the first JSON object out of it
  return await textPath();

}
