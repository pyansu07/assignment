import { execSync } from 'node:child_process';

// Applies all migrations to the disposable test database before the suite runs.
export default function setup() {
  execSync('npx prisma migrate deploy', {
    stdio: 'pipe',
    env: { ...process.env, DATABASE_URL: process.env.DATABASE_URL },
  });
}
