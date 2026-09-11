import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["logo.png", "favicon.ico"],
      manifest: {
        name: "Hyperoom v2",
        short_name: "Hyperoom",
        description: "Chat realtime ala mIRC modern — ngobrol seru, server rumah sendiri",
        theme_color: "#2563eb",
        background_color: "#f0f2f5",
        display: "standalone",
        start_url: "/",
        icons: [
          { src: "/logo.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/logo.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "/logo.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,png,jpg,svg,ico}"],
        navigateFallback: "/index.html",
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