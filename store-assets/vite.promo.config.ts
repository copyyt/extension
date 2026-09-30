// Static build of the promo video pages, so capture-video.mjs can load it from disk.
// yarn vite build --config store-assets/vite.promo.config.ts --outDir <dir>
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

export default defineConfig({
  root: path.resolve(__dirname),
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(__dirname, "../src") } },
  build: {
    emptyOutDir: true,
    rollupOptions: {
      input: {
        video: path.resolve(__dirname, "promo-video.html"),
        lineup: path.resolve(__dirname, "promo-lineup.html"),
        showcase: path.resolve(__dirname, "promo-showcase.html"),
      },
    },
  },
});
