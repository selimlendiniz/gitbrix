import { defineConfig } from "@playwright/test";

// UI tests run against the Vite dev server in a plain browser; the app
// detects there is no Tauri backend and serves src/mock/fixture.json.
export default defineConfig({
  testDir: "tests/ui",
  outputDir: "test-results",
  timeout: 30_000,
  use: {
    baseURL: "http://localhost:1420",
    // Use the system Chrome instead of downloading a browser.
    channel: "chrome",
    headless: true,
    viewport: { width: 1400, height: 860 },
    colorScheme: "dark",
  },
  webServer: {
    command: "pnpm dev",
    url: "http://localhost:1420",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
