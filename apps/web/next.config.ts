import type { NextConfig } from "next";
import { fileURLToPath } from "node:url";

const nextConfig: NextConfig = {
  // Lets a rebuild go to a separate directory so it cannot pull .next out from
  // under a running `next start` — which previously destroyed live missions.
  distDir: process.env.NEXT_DIST_DIR || ".next",
  turbopack: {
    // the repo root holds its own lockfile (neon.ts + db/), so pin the root here
    root: fileURLToPath(new URL(".", import.meta.url)),
    // Tailwind v4 runs as a Turbopack CSS loader. Without this rule NO utility
    // classes are generated at all — the app renders with only the handful of
    // custom classes in globals.css, which is how the whole UI ended up unstyled.
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
  // native/dynamic-require packages must not be bundled:
  // @daytonaio/sdk's uploader does require('form-data') at runtime
  serverExternalPackages: ["pg", "postgres", "sharp", "@daytonaio/sdk"],
};

export default nextConfig;
