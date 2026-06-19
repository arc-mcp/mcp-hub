// Server assembly: shared inbound auth + a transparent proxy route per backend.

import express, { type Express, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import { createAllHandlers } from './aggregate.js';
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
  // Behind CF's Gorouter the real client IP arrives in X-Forwarded-For. Trust the first
  // proxy hop so the MCP SDK auth router's express-rate-limit keys on the real client IP
  // instead of throwing ERR_ERL_UNEXPECTED_X_FORWARDED_FOR. `1` (not `true`) so a client
  // can't spoof XFF past the single trusted hop. Mirrors arc-1's server.
  app.set('trust proxy', 1);
  app.use(express.json());

  app.get('/healthz', (_req, res) => {
    res.json({ status: 'ok', backends: config.backends.map((b) => b.name) });
  });

  const envNames = config.backends.map((b) => b.name);
  if (config.allEndpoint) envNames.push('all');
  const bearers = setupInboundAuth(app, envNames);
  const resolve = createResolver();

  for (const backend of config.backends) {
    const bearer = bearers[backend.name];
    const { post, get, del } = createEnvHandlers({
      getUserJwt,
      resolve: (userJwt) => resolve(backend.destination, userJwt),
      sessionTtlMs: config.sessionTtlMs,
    });
    const path = `/${backend.name}/mcp`;
    app.post(path, bearer, wrap(post));
    app.get(path, bearer, wrap(get));
    app.delete(path, bearer, wrap(del));
    log.info('mounted backend', { env: backend.name, destination: backend.destination, path });
  }

  // Optional aggregated endpoint: one URL, every system via a required `system` param.
  if (config.allEndpoint) {
    const all = createAllHandlers({
      backends: config.backends,
      getUserJwt,
      resolve,
      sessionTtlMs: config.sessionTtlMs,
    });
    app.post('/all/mcp', bearers.all, wrap(all.post));
    app.get('/all/mcp', bearers.all, wrap(all.get));
    app.delete('/all/mcp', bearers.all, wrap(all.del));
    log.info('mounted aggregated endpoint', { path: '/all/mcp', systems: config.backends.map((b) => b.name) });
  }

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    log.error('request error', { error: err?.message });
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', id: null, error: { code: -32000, message: 'internal error' } });
    }
  });

  return app;
}
