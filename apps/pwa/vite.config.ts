import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
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