import path from "path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
import tailwindcss from "@tailwindcss/postcss";
import autoprefixer from "autoprefixer";

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      // Registration is owned by src/lib/pwa.ts: the injected script only
      // calls register() on load, so a new worker activates without the
      // running page ever reloading (and a long-lived tab never re-checks).
      injectRegister: null,
      // Only files that exist; the old list named a favicon.svg that never
      // shipped (plan §12.14: ship the icon the manifest names).
      includeAssets: ["favicon.png", "icons.svg", "logo.png"],
      manifest: {
        name: "owlshelf",
        short_name: "owlshelf",
        description: "Browse and manage your bookshelf",
        start_url: "/",
        display: "standalone",
        background_color: "#ffffff",
        theme_color: "#863bff",
        icons: [
          {
            // The real app icon: 1024×1024 PNG (the old "48x46" sizes value
            // never matched any shipped asset).
            src: "/favicon.png",
            sizes: "1024x1024",
            type: "image/png",
            purpose: "any",
          },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,svg,png,ico,json,webmanifest}"],
      },
      devOptions: {
        // Plan §12.14: dev SWs serve stale cached bundles and break
        // migration debugging. Use ?clear-sw when a SW needs evicting.
        enabled: false,
      },
    }),
  ],
  css: {
    postcss: { plugins: [tailwindcss, autoprefixer] },
  },
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "./src"),
    },
  },
});
