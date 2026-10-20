/**
 * @author zhaoyu · https://github.com/SUJIElearning/sensenova-duokey
 * Host half: relay the SenseNova proxy's /status to the Web page.
 *
 * The browser cannot read http://127.0.0.1:15722/status directly: that proxy
 * sends no CORS header and the page is a different origin. This relay runs in
 * the Host process (Node, no CORS) and re-publishes only the two counters the
 * composer dock needs, with an explicit CORS header for the page.
 *
 * The relay is bound to loopback and exposes read-only counters, so it leaks
 * nothing beyond "how many API keys are usable right now".
 */
import http from 'node:http';

/** Loopback port for the relay; deliberately outside the proxy/DSh ports. */
const RELAY_PORT = 15799;
/** Local SenseNova multi-key proxy status endpoint. */
const PROXY_STATUS_URL = 'http://127.0.0.1:15722/status';

/**
 * Read the proxy status once.
 * @returns {Promise<{ok: boolean, available?: number, total?: number}>}
 *   counters when the proxy answered, `{ ok: false }` when it is down.
 */
function readProxyStatus() {
  return new Promise((resolve) => {
    const request = http.get(PROXY_STATUS_URL, { timeout: 2000 }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve({
            ok: true,
            available: Number(data.availableNow) || 0,
            total: Number(data.totalKeys) || 0,
          });
        } catch {
          resolve({ ok: false });
        }
      });
    });
    request.on('error', () => resolve({ ok: false }));
    request.on('timeout', () => {
      request.destroy();
      resolve({ ok: false });
    });
  });
}

/**
 * Start the relay for this profile.
 * @param {import('@deepseek-ai/cordis').Context} ctx - owning plugin context.
 */
export function apply(ctx) {
  const server = http.createServer(async (request, response) => {
    if (request.url === undefined || !request.url.startsWith('/keys')) {
      response.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
      response.end('not found');
      return;
    }
    const payload = await readProxyStatus();
    const body = JSON.stringify(payload);
    response.writeHead(200, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(body),
    });
    response.end(body);
  });

  server.on('error', (error) => {
    ctx.logger?.warn?.(`sensenova-key-status relay could not listen on ${RELAY_PORT}: ${error.message}`);
  });

  server.listen(RELAY_PORT, '127.0.0.1');

  ctx.effect(() => () => {
    try {
      server.close();
    } catch {
      /* already closed */
    }
  });
}