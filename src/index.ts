// Entry point.

import { loadHubConfig } from './config.js';
import { log } from './log.js';
import { createServer } from './server.js';

export function startServer(): void {
  const config = loadHubConfig();
  const app = createServer(config);
  const port = Number(process.env.PORT) || 9000;
  const server = app.listen(port, () => {
    log.info('arc-mcp-hub listening', { port, backends: config.backends.map((b) => b.name) });
  });
  // CF Gorouter closes idle keep-alive connections at 90s; outlast it so the app
  // loses the close race to the router, not vice-versa. requestTimeout 0 for SSE.
  server.keepAliveTimeout = 120_000;
  server.requestTimeout = 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  startServer();
}
