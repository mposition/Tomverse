import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/chat", name: "Tomverse Chat", short_name: "Tomverse",
    description: "Chat with Tomverse and continue your saved conversations.",
    start_url: "/chat", scope: "/", display: "standalone",
    background_color: "#faf9f6", theme_color: "#172a46",
    icons: [192, 512].map((size) => ({ src: `/pwa/icon-${size}.png`, sizes: `${size}x${size}`, type: "image/png", purpose: "any" })),
  };
}
