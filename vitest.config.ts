import { config } from 'dotenv';
import { defineConfig } from 'vitest/config';

config();

const testUrl = process.env.TEST_DATABASE_URL;
if (!testUrl) throw new Error('TEST_DATABASE_URL is required to run tests (see .env.example).');
// Safety: tests TRUNCATE every table, so never point them at a non-test database.
if (!/\/[^/?]*_test(\?|$)/.test(testUrl)) {
  throw new Error('TEST_DATABASE_URL must point at a database whose name ends with "_test".');
}

export default defineConfig({
  test: {
    env: { DATABASE_URL: testUrl, NODE_ENV: 'test' },
    globalSetup: ['tests/helpers/globalSetup.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    include: ['tests/**/*.test.ts'],
  },
});
