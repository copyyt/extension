import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { viteStaticCopy } from "vite-plugin-static-copy";
import { VitePWA } from "vite-plugin-pwa";

const env = loadEnv("", process.cwd(), "");
const target = env.VITE_APP_TYPE || "extension";
const isPWA = target === "web";

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    viteStaticCopy({
      targets: [
        {
          src: `manifest.${target}.json`,
          dest: ".",
          rename: "manifest.json",
        },
      ],
    }),
    ...(isPWA
      ? [
          VitePWA({
            registerType: "autoUpdate",
            includeAssets: ["logo.svg"],
            manifest: false,
          }),
        ]
      : []),
  ],
  resolve: {
    alias: {
      "@": "/src",
    },
  },
  build: {
    outDir: target === "extension" ? "build-extension" : "build",
    rollupOptions: {
      input: {
        main: "./index.html",
      },
    },
  },
});
