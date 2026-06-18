// Minimal stderr logger. The hub is an HTTP server, so stdout is free — but we
// keep logs on stderr by convention and to stay MCP-proxy-safe. One module so
// `console` lives in exactly one place.

type Extra = Record<string, unknown> | undefined;

function write(level: string, msg: string, extra?: Extra): void {
  const suffix = extra ? ` ${JSON.stringify(extra)}` : '';
  process.stderr.write(`[arc-mcp-hub] ${level} ${msg}${suffix}\n`);
}

export const log = {
  info: (msg: string, extra?: Extra) => write('INFO', msg, extra),
  warn: (msg: string, extra?: Extra) => write('WARN', msg, extra),
  error: (msg: string, extra?: Extra) => write('ERROR', msg, extra),
};
