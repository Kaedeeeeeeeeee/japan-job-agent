import type { NextConfig } from "next";

const config: NextConfig = {
  output: "standalone",
  poweredByHeader: false,
  turbopack: { root: "../.." },
  experimental: { optimizePackageImports: ["lucide-react"] },
};

export default config;
