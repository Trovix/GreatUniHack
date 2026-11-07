import { defineConfig } from 'vitest/config';
import { resolve } from 'node:path';
process.env.PLAYWRIGHT_BROWSERS_PATH ??= resolve('.cache/playwright');
export default defineConfig({test:{include:['tests/unit/**/*.test.ts','tests/integration/**/*.test.ts'],testTimeout:20000}});
