import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * `@napi-rs/canvas` is a native binding, used to rasterise scanned PDFs so a
   * vision model can read them. Webpack has no loader for a `.node` binary and
   * fails the build trying to bundle one, so it is left to Node's own require
   * at runtime. `unpdf` is listed with it because it is what reaches for the
   * canvas.
   */
  serverExternalPackages: ["@napi-rs/canvas", "unpdf"],
};

export default nextConfig;
