/** Dev-only: prove Gemini label QA works through TokenRouter on inline bytes. */
import { NextResponse } from "next/server";
import sharp from "sharp";
import { verifyLabel } from "@/mastra/tools/vision";
import { visionConfigured } from "@/mastra/tools/llm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (process.env.NODE_ENV === "production") {
    return NextResponse.json({ error: "not found" }, { status: 404 });
  }
  // a synthetic image the model can verifiably describe: a big red circle
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240">
    <rect width="320" height="240" fill="#f5f5f0"/>
    <circle cx="160" cy="120" r="80" fill="#dc2828"/></svg>`;
  const webp = await sharp(Buffer.from(svg)).webp({ quality: 80 }).toBuffer();
  const dataUrl = `data:image/webp;base64,${webp.toString("base64")}`;

  const t0 = Date.now();
  const shouldPass = await verifyLabel({
    imageUrl: dataUrl,
    classLabel: "a large red circle",
    otherLabel: "a photograph of a plant",
  });
  const shouldFail = await verifyLabel({
    imageUrl: dataUrl,
    classLabel: "a photograph of redroot pigweed in a field",
    otherLabel: "a geometric shape",
  });
  return NextResponse.json({
    configured: visionConfigured(),
    model: process.env.TOKENROUTER_VISION_MODEL,
    ms: Date.now() - t0,
    bytes: webp.length,
    claim_red_circle: shouldPass,     // expect verified: true
    claim_pigweed_photo: shouldFail,  // expect verified: false
  });
}
