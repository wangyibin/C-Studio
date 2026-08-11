import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    host: "127.0.0.1",
    port: 1420,
    strictPort: true,
  },
  // Expose only the diagnostic flag so the same command enables Rust and WebView timings.
  envPrefix: ["VITE_", "TAURI_", "CSTUDIO_PERF_LOG"],
});
