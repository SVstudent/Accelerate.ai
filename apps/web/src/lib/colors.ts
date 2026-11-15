/** DESIGN.md §1.1 tokens, for Three.js and chart code that cannot read CSS vars. */
export const C = {
  soil950: "#12100C", soil900: "#1B1813", soil800: "#26221B", soil700: "#3A3428",
  chaff200: "#E9E2D0", chaff400: "#B3AA94", chaff600: "#7D7563",
  leaf400: "#6BCB77",    // crop / protect
  bloom400: "#E05BB5",   // weed / target
  signal400: "#F2B33D",  // agent activity, trained rover
  blight500: "#E5484D",  // damage, errors
  sky400: "#5FB3D9",     // baseline policy
  judge: "#B69CFF",      // Judge monogram only
} as const;

/** Score halo ramp: blight → signal → leaf (DESIGN.md §4.1). */
export function scoreColor(score: number | null | undefined): string {
  if (score === null || score === undefined || Number.isNaN(score)) return C.soil700;
  const t = Math.max(0, Math.min(1, (score + 0.2) / 1.2)); // score ∈ ~[-0.2, 1]
  const stops: [number, [number, number, number]][] = [
    [0.0, [229, 72, 77]],
    [0.5, [242, 179, 61]],
    [1.0, [107, 203, 119]],
  ];
  let a = stops[0], b = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (t >= stops[i][0] && t <= stops[i + 1][0]) { a = stops[i]; b = stops[i + 1]; break; }
  }
  const span = b[0] - a[0] || 1;
  const k = (t - a[0]) / span;
  const rgb = a[1].map((v, i) => Math.round(v + (b[1][i] - v) * k));
  return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
}

export const AGENT_COLOR: Record<string, string> = {
  foreman: C.chaff200, scout: C.sky400, curator: C.bloom400,
  architect: C.signal400, trainer: C.leaf400, judge: C.judge, system: C.chaff600,
};
