import type { MetadataRoute } from "next";

export const dynamic = "force-static"; // required for `output: export`

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "D&D Combat Sim",
    short_name: "Combat Sim",
    description: "Narrated D&D combat, run turn-by-turn from a chat window.",
    start_url: `${basePath}/`,
    scope: `${basePath}/`,
    display: "standalone",
    background_color: "#09090b",
    theme_color: "#4f46e5",
    icons: [
      { src: `${basePath}/icon-192.png`, sizes: "192x192", type: "image/png" },
      { src: `${basePath}/icon-512.png`, sizes: "512x512", type: "image/png" },
      { src: `${basePath}/icon-512.png`, sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
