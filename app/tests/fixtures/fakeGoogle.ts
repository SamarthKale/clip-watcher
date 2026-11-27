import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { GoogleEndpoints } from '../../src/server/youtube/oauth.js';

export interface FakeGoogle {
  endpoints: GoogleEndpoints;
  refreshCalls: number;
  exchangeBodies: URLSearchParams[];
  /** When true the token endpoint answers refresh requests with invalid_grant. */
  revoked: boolean;
  channel: { id: string; title: string } | null;
  close(): Promise<void>;
}

export async function startFakeGoogle(): Promise<FakeGoogle> {
  const state: FakeGoogle = {
    endpoints: { authUrl: '', tokenUrl: '', channelsUrl: '' },
    refreshCalls: 0,
    exchangeBodies: [],
    revoked: false,
    channel: { id: 'UC123', title: 'My Channel' },
    close: async () => undefined,
  };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url?.startsWith('/token')) {
        const body = new URLSearchParams(raw);
        if (body.get('grant_type') === 'refresh_token') {
          state.refreshCalls++;
          if (state.revoked) {
            res.statusCode = 400;
            return res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }));
          }
          return res.end(JSON.stringify({ access_token: `AT-refreshed-${state.refreshCalls}`, expires_in: 3600 }));
        }
        state.exchangeBodies.push(body);
        return res.end(JSON.stringify({ access_token: 'AT-first', refresh_token: 'RT-secret-1', expires_in: 3600 }));
      }
      if (req.url?.startsWith('/channels')) {
        if (!req.headers.authorization?.startsWith('Bearer AT-')) {
          res.statusCode = 401;
          return res.end('{}');
        }
        return res.end(JSON.stringify({ items: state.channel ? [{ id: state.channel.id, snippet: { title: state.channel.title } }] : [] }));
      }
      res.statusCode = 404;
      res.end('{}');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  state.endpoints = { authUrl: `${base}/auth`, tokenUrl: `${base}/token`, channelsUrl: `${base}/channels` };
  state.close = () => new Promise<void>((r) => server.close(() => r()));
  return state;
}
