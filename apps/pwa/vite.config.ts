import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: "auto",
      includeAssets: ["logo.png"],
      manifest: {
        name: "Hyperoom v2",
        short_name: "Hyperoom",
        description: "Chat realtime — ngobrol seru, server rumah sendiri",
        theme_color: "#2563eb",
        background_color: "#f0f2f5",
        display: "standalone",
        start_url: "/",
        icons: [
          { src: "/logo.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "/logo.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,png,jpg,svg,ico}"],
        navigateFallback: "/index.html",
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/[a-z0-9-]+\.trycloudflare\.com\/(api|avatars|realtime)/,
            handler: "NetworkOnly",
          },
        ],
      },
    }),
  ],
  server: {
    port: 3101,
    proxy: {
      "/api": "http://localhost:3100",
      "/health": "http://localhost:3100",
      "/monitor": "http://localhost:3100",
      "/avatars": "http://localhost:3100",
      "/realtime": {
        target: "ws://localhost:3100",
        ws: true,
      },
    },
  },
});