import type { NextConfig } from "next";

// GitHub Pages serves a project repo at /<repo-name>/, not the domain root.
// Set only by the CI build (.github/workflows/deploy.yml); local dev/build
// stays at root so `npm run dev` and a plain `next build` still work.
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

const nextConfig: NextConfig = {
  output: "export",
  basePath,
  images: { unoptimized: true }, // next/image's optimizer needs a server; static export has none
};

export default nextConfig;
