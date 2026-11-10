import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/demo",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: "list",
  timeout: 120_000,
  expect: { timeout: 15_000 },
  use: {
    ...devices["Desktop Chrome"],
    baseURL: "http://localhost:1420",
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
    video: { mode: "on", size: { width: 1280, height: 720 } },
    trace: "off",
  },
  webServer: {
    command: "npm run dev",
    url: "http://localhost:1420",
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
