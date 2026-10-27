import { createApp } from './app';
import { env } from './config/env';
import { prisma } from './db/prisma';
import { logger } from './utils/logger';

const server = createApp().listen(env.port, () => {
  logger.info(`Ledger API listening on http://localhost:${env.port} (docs: /docs)`);
});

async function shutdown() {
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
