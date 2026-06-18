// Server assembly: shared inbound auth + a transparent proxy route per backend.

import express, { type Express, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { getUserJwt, setupInboundAuth } from './auth.js';
import type { HubConfig } from './config.js';
import { createResolver } from './exchange.js';
import { log } from './log.js';
import { createEnvHandlers } from './proxy.js';

type AsyncHandler = (req: Request, res: Response) => Promise<void>;

// Forward async-handler rejections to the Express error handler.
const wrap =
  (h: AsyncHandler): RequestHandler =>
  (req, res, next) => {
    h(req, res).catch(next);
  };

/** Build the Express app. Auth + the per-user exchange come from the real BTP bindings. */
export function createServer(config: HubConfig): Express {
  const app = express();
  app.use(express.json());

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', backends: config.backends.map((b) => b.name) });
  });

  const bearers = setupInboundAuth(
    app,
    config.backends.map((b) => b.name),
  );
  const resolve = createResolver();

  for (const backend of config.backends) {
    const bearer = bearers[backend.name];
    const { post, get, del } = createEnvHandlers({
      getUserJwt,
      resolve: (userJwt) => resolve(backend.destination, userJwt),
    });
    const path = `/${backend.name}/mcp`;
    app.post(path, bearer, wrap(post));
    app.get(path, bearer, wrap(get));
    app.delete(path, bearer, wrap(del));
    log.info('mounted backend', { env: backend.name, destination: backend.destination, path });
  }

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    log.error('request error', { error: err?.message });
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'internal error' } });
    }
  });

  return app;
}
