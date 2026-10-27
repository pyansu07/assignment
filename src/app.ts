import express from 'express';
import swaggerUi from 'swagger-ui-express';
import { openApiSpec } from './docs/openapi';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { router } from './routes';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '10kb' }));

  app.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok' });
  });
  app.get('/openapi.json', (_req, res) => {
    res.status(200).json(openApiSpec);
  });
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(openApiSpec));

  app.use(router);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
