import type { NextConfig } from "next";

// Served at learn.aivn360.com/claude-code; NEXT_PUBLIC_BASE_PATH is set in vercel.json.
const basePath = process.env.NEXT_PUBLIC_BASE_PATH || "";

const nextConfig: NextConfig = {
  output: "export",
  images: { unoptimized: true },
  trailingSlash: true,
  ...(basePath ? { basePath } : {}),
};

export default nextConfig;
