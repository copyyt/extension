import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { viteStaticCopy } from "vite-plugin-static-copy";
import { VitePWA } from "vite-plugin-pwa";

const env = loadEnv("", process.cwd(), "");
const target = env.VITE_APP_TYPE || "extension";
const isPWA = target === "web";
const isExtensionWorkerBuild = env.VITE_EXTENSION_BUILD === "worker";
const isExtension = target === "extension";
const extensionEnvironment = env.VITE_EXTENSION_ENV === "store" ? "store" : "dev";
const extensionOutputDirectory =
  env.VITE_EXTENSION_OUTPUT ||
  (extensionEnvironment === "store" ? "build-extension-store" : "build-extension");
const manifestSource = isExtension
  ? `manifest.extension.${extensionEnvironment}.json`
  : `manifest.${target}.json`;

const mv3GlobalObjectPlugin = {
  name: "copyyt-mv3-global-object",
  apply: "build" as const,
  renderChunk(code: string) {
    const hardenedCode = code.replace(
      /Function\(\s*["']return this["']\s*\)\(\s*\)/gu,
      "globalThis",
    );
    return hardenedCode === code ? null : { code: hardenedCode, map: null };
  },
};

const extensionInputs = isExtensionWorkerBuild
  ? "./src/service-worker.ts"
  : {
      main: "./index.html",
      ...(isExtension ? { offscreen: "./src/offscreen.ts" } : {}),
    };

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    ...(isExtension ? [mv3GlobalObjectPlugin] : []),
    viteStaticCopy({
      targets: [
        {
          src: manifestSource,
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
    outDir: target === "extension" ? extensionOutputDirectory : "build",
    emptyOutDir: !isExtensionWorkerBuild,
    ...(isExtension ? { modulePreload: false } : {}),
    rollupOptions: {
      input: isPWA || isExtensionWorkerBuild ? extensionInputs : {
        main: "./index.html",
        offscreen: "./src/offscreen.ts",
      },
      output: {
        entryFileNames: "assets/[name].js",
        ...(isExtensionWorkerBuild ? { inlineDynamicImports: true } : {}),
      },
    },
  },
});
