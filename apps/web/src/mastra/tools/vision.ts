/**
 * Curator's image-label QA (CLAUDE.md §4, Gemini track).
 * Gemini is reached through TokenRouter's OpenAI-compatible endpoint.
 * A verdict of `null` means "not checked" and is stored as such — we never
 * silently accept an unverified label (dataset_items.verified is nullable).
 */
import { z } from "zod";
import { structured } from "./llm";
import { visionModel, visionConfigured } from "./llm";

export const Verdict = z.object({
  verified: z.boolean(),
  note: z.string().max(140),
});
export type Verdict = z.infer<typeof Verdict>;

export type LabelCheck = {
  imageUrl: string;
  classLabel: string;   // the subject claimed, e.g. 'Amaranthus retroflexus (redroot pigweed)'
  otherLabel: string;   // the subject it must NOT be
  /**
   * Set for a deliberately mined look-alike (curator hard negatives): the two
   * subjects are known to be confusable, so the verifier is told to look for
   * the distinguishing detail instead of answering from the gist.
   */
  lookalike?: boolean;
};

/**
 * Domain-neutral on purpose. The platform is not agriculture-specific — the
 * next mission may be separating ore from waste rock or pallets from people —
 * so the prompt names no domain and the subjects come from the task spec.
 */
const PROMPT = `You verify training-image labels for a machine-vision dataset used by an autonomous system.
Answer whether the image really shows the claimed subject.
Reject it if the image is a diagram, illustration, logo, map, chart, screenshot,
product or packaging shot, a close-up of a person, or clearly the other subject
instead. Accept real photographs of the claimed subject in its normal working
setting, at any stage, size or viewpoint. Keep the note under 20 words.`;

/** Verify one image. Returns null when vision QA is not configured. */
export async function verifyLabel(check: LabelCheck): Promise<Verdict | null> {
  if (!visionConfigured()) return null;
  const model = visionModel();
  if (!model) return null;
  try {
    // structured() routes through tool-calling first: these gateways reject
    // JSON-schema response_format, which made generateObject fail outright.
    return await structured({
      schema: Verdict,
      name: "submit_verdict",
      description: "Report whether the image really shows the claimed subject.",
      instructions: PROMPT,
      prompt: `Claimed: ${check.classLabel}. Must not be: ${check.otherLabel}.` +
        (check.lookalike
          ? " These two are commonly mistaken for each other — decide on the distinguishing detail, not the overall impression."
          : "") +
        " Is the claim correct?",
      images: [check.imageUrl],
      model,
      // this gateway rejects tool JSON Schema ($schema) but answers plain JSON
      prefer: "text",
    });
  } catch (err) {
    // keep the log short: imageUrl may be a multi-KB data: URL
    const where = check.imageUrl.startsWith("data:")
      ? `data:${check.imageUrl.length}B` : check.imageUrl.slice(0, 80);
    console.warn("[vision] verify failed:", where, (err as Error).message);
    return null;
  }
}

/** Verify a batch with bounded concurrency; order is preserved. */
export async function verifyLabels(
  checks: LabelCheck[],
  concurrency = 8,
): Promise<(Verdict | null)[]> {
  const out: (Verdict | null)[] = new Array(checks.length).fill(null);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, checks.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= checks.length) return;
      out[i] = await verifyLabel(checks[i]);
    }
  });
  await Promise.all(workers);
  return out;
}
