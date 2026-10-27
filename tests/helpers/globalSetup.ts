import { execSync } from 'node:child_process';

// Applies all migrations to the disposable test database before the suite runs.
// Runs in the main vitest process, where `test.env` is NOT applied, so the target is passed explicitly.
export default function setup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url || !/\/[^/?]*_test(\?|$)/.test(url)) {
    throw new Error('TEST_DATABASE_URL must be set and point at a database whose name ends with "_test".');
  }
  execSync('npx prisma migrate deploy', { stdio: 'pipe', env: { ...process.env, DATABASE_URL: url } });
}
