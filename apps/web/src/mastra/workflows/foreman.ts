/**
 * Foreman — the chat-facing agent (CLAUDE.md §4).
 * Parses a spoken or typed goal into a TaskSpec the user confirms once.
 */
import { eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { z } from "zod";
import { TaskSpec } from "@/lib/contracts";
import { structured } from "@/mastra/tools/llm";
import type { EventSink } from "@/mastra/tools/events";

const SYSTEM = `You turn a farmer's request into a TaskSpec for an agricultural robot.

The robot handles ONE family of tasks: "act on class A, avoid class B".
 · selective_removal  — target = weed species, protect = the crop
 · selective_harvest  — target = ripe fruit, protect = unripe fruit

Rules:
 · Use the exact species the farmer names. Add the scientific name only when you
   are confident it is correct; otherwise leave the list empty.
 · priorities.avoid_damage rises toward 1.0 when the farmer stresses not harming
   the crop ("without touching the strawberries").
 · region_hint only if the farmer names a place.
 · Keep the default budget unless the farmer asks for something bigger.
 · Reply in the same language the farmer used for any prose, but keep the
   species names in their common form.`;

/**
 * A flat schema the LLM can actually fill. Deeply nested objects with tuples
 * and defaults made glm-5.3 miss the schema outright, so we generate something
 * simple and assemble the strict TaskSpec in code.
 */
const GoalDraft = z.object({
  template: z.enum(["selective_removal", "selective_harvest"])
    .describe("selective_removal for weeding, selective_harvest for picking ripe fruit"),
  crop: z.string().describe("the crop being grown, e.g. strawberry"),
  target_names: z.array(z.string()).describe("what the robot should act on, common names"),
  target_scientific: z.array(z.string()).describe("scientific names, empty if unsure"),
  target_stage_hint: z.string().describe("growth stage if mentioned, else empty string"),
  protect_names: z.array(z.string()).describe("what must NOT be harmed, common names"),
  protect_scientific: z.array(z.string()).describe("scientific names, empty if unsure"),
  avoid_damage: z.number().describe("0..1, near 1 when the farmer stresses not harming the crop"),
  coverage: z.number().describe("0..1, how important removing every target is"),
  speed: z.number().describe("0..1, how important finishing fast is"),
  region_hint: z.string().describe("place name if mentioned, else empty string"),
});

const clamp01 = (n: number, d: number) =>
  Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : d;

export async function parseGoal(opts: {
  missionId: string; goalText: string; lang?: string; onEvent?: EventSink;
}): Promise<TaskSpec> {
  await opts.onEvent?.({
    agent: "foreman", kind: "thought",
    title: `Reading the goal: "${opts.goalText.slice(0, 80)}"`,
  });

  const draft = await structured({
    schema: GoalDraft,
    name: "submit_task_spec",
    description: "Submit the parsed robot task.",
    instructions: SYSTEM,
    prompt: `Farmer's request (language: ${opts.lang ?? "en"}):\n${opts.goalText}`,
  });

  // assemble the strict contract from the flat draft
  const spec: TaskSpec = TaskSpec.parse({
    template: draft.template,
    crop: draft.crop,
    target: {
      key: "target",
      names: draft.target_names.filter(Boolean),
      scientific: draft.target_scientific.filter(Boolean),
      ...(draft.target_stage_hint ? { stage_hint: draft.target_stage_hint } : {}),
    },
    protect: {
      key: "protect",
      names: draft.protect_names.filter(Boolean),
      scientific: draft.protect_scientific.filter(Boolean),
    },
    priorities: {
      avoid_damage: clamp01(draft.avoid_damage, 0.9),
      coverage: clamp01(draft.coverage, 0.7),
      speed: clamp01(draft.speed, 0.3),
    },
    ...(draft.region_hint ? { region_hint: draft.region_hint } : {}),
    lang: opts.lang ?? "en",
    budget: { generations: 3, variants: 4, steps_per_run: 800_000 },
  });

  await db.update(schema.missions)
    .set({ taskSpec: spec, goalLang: spec.lang, status: "awaiting_confirm", updatedAt: new Date() })
    .where(eq(schema.missions.id, opts.missionId));

  await opts.onEvent?.({
    agent: "foreman", kind: "decision",
    title: `Task: remove ${spec.target.names.join(" + ")}, protect ${spec.protect.names.join(" + ")}`,
    payload: { task_spec: spec },
  });
  return spec;
}

/** Title for the console's top bar. */
export function missionTitle(spec: TaskSpec | null, fallback: string): string {
  if (!spec) return fallback.slice(0, 60);
  return `${spec.crop} bed · ${spec.target.names.slice(0, 2).join(" + ")}`;
}
