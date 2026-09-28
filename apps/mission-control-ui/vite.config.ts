import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5174,
    proxy: {
      "/api": {
        target: process.env.PAIR_MC_API ?? "http://localhost:8788",
        changeOrigin: true,
      },
    },
  },
  build: { outDir: "dist" },
});
