import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { Db } from './db/db.js';
import { dataDirPath } from './config.js';
import { pickFolder as nativePickFolder } from './folders/nativeDialog.js';
import { createSecretStore, type SecretStore } from './secrets/secretStore.js';
import { getSettings } from './settings.js';
import { makeProviderGetter } from './ai/providerFactory.js';
import type { AiProvider } from './ai/provider.js';
import { registerFolderRoutes } from './routes/folders.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerProfileRoutes } from './routes/profiles.js';
import { registerMetadataRoutes } from './routes/metadata.js';
import { registerAccountRoutes, CLIENT_SECRET_NAME } from './routes/accounts.js';
import { registerQueueRoutes } from './routes/queue.js';
import { registerHistoryRoutes } from './routes/history.js';
import { registerDashboardRoutes } from './routes/dashboard.js';
import { registerVideoRoutes } from './routes/videos.js';
import { registerPipelineRoutes } from './routes/pipeline.js';
import { createAccountAuth, type AccountAuth } from './youtube/accounts.js';
import { GOOGLE_ENDPOINTS, type GoogleEndpoints } from './youtube/oauth.js';

export interface AppDeps {
  db: Db;
  /** Per-launch token printed in the startup link. */
  token: string;
  /** Persisted secret stored in the browser's session cookie, so refreshes, new tabs and restarts keep working. */
  sessionSecret: string;
  pickFolder: () => Promise<string | null>;
  secrets: SecretStore;
  getProvider: () => Promise<AiProvider | null>;
  /** App-owned scratch directory for extracted frames. */
  tempDir: () => string;
  oauthEndpoints: GoogleEndpoints;
  auth: AccountAuth;
}

export type AppInit = Pick<AppDeps, 'db' | 'token'> & Partial<Omit<AppDeps, 'db' | 'token'>>;

const COOKIE = 'lt_session';

/** Constant-time string comparison. */
function same(a: string | undefined, b: string): boolean {
  if (typeof a !== 'string') return false;
  const x = crypto.createHash('sha256').update(a).digest();
  const y = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(x, y);
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

export function buildApp(init: AppInit): FastifyInstance {
  const secrets = init.secrets ?? createSecretStore(path.join(dataDirPath(), 'secrets.json'));
  const oauthEndpoints = init.oauthEndpoints ?? GOOGLE_ENDPOINTS;
  const deps: AppDeps = {
    sessionSecret: crypto.randomBytes(32).toString('hex'),
    pickFolder: nativePickFolder,
    getProvider: makeProviderGetter(init.db, secrets),
    tempDir: () => getSettings(init.db).tempDir || path.join(os.tmpdir(), 'localtube-work'),
    auth: createAccountAuth({
      db: init.db,
      secrets,
      endpoints: oauthEndpoints,
      getClient: async () => ({ clientId: getSettings(init.db).googleClientId, clientSecret: (await secrets.get(CLIENT_SECRET_NAME)) ?? undefined }),
    }),
    ...init,
    secrets,
    oauthEndpoints,
  };
  const app = Fastify({ logger: false });
  app.decorate('deps', deps);
  app.addHook('onRequest', async (req, reply) => {
    // A web page on another origin can make the browser send requests to 127.0.0.1 (DNS rebinding).
    // Only localhost host names are served; the per-launch token is the second lock on /api.
    if (!/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(req.headers.host ?? '')) {
      return reply.code(403).send({ error: 'forbidden host' });
    }
    // Match on the DECODED path: the router decodes percent-escapes, so "/%61pi/..." reaches /api routes.
    let pathname = req.url.split('?')[0];
    try {
      pathname = decodeURIComponent(pathname);
    } catch {
      return reply.code(400).send({ error: 'bad request path' });
    }
    if (/^\/+api(\/|$)/i.test(pathname)) {
      const byLaunchToken = same(req.headers['x-localtube-token'] as string | undefined, deps.token);
      // The cookie is SameSite=Strict, and a custom header is required alongside it, so another website cannot ride on it.
      const byCookie = req.headers['x-localtube-client'] === 'ui' && same(cookieValue(req.headers.cookie, COOKIE), deps.sessionSecret);
      if (!byLaunchToken && !byCookie) return reply.code(401).send({ error: 'unauthorized' });
    }
  });
  app.addHook('onSend', async (_req, reply) => {
    reply.header('content-security-policy', "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
  });
  app.get('/api/health', async () => ({ ok: true }));
  // Exchanges a valid credential for the long-lived session cookie.
  app.post('/api/session/login', async (_req, reply) => {
    reply.header('set-cookie', `${COOKIE}=${deps.sessionSecret}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`);
    return { ok: true };
  });
  registerFolderRoutes(app);
  registerSettingsRoutes(app);
  registerProfileRoutes(app);
  registerMetadataRoutes(app);
  registerAccountRoutes(app);
  registerQueueRoutes(app);
  registerHistoryRoutes(app);
  registerDashboardRoutes(app);
  registerVideoRoutes(app);
  registerPipelineRoutes(app);

  // The built React UI (npm run build:ui). Absent in tests and during API-only development.
  // The installed app keeps it next to the bundled server and points here with LOCALTUBE_UI_DIR.
  const uiDir = process.env.LOCALTUBE_UI_DIR ? path.resolve(process.env.LOCALTUBE_UI_DIR) : path.resolve(process.cwd(), 'dist', 'ui');
  if (fs.existsSync(path.join(uiDir, 'index.html'))) {
    void app.register(fastifyStatic, { root: uiDir });
    app.setNotFoundHandler((req, reply) =>
      req.url.startsWith('/api/') ? reply.code(404).send({ error: 'not found' }) : reply.sendFile('index.html'),
    );
  }
  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    deps: AppDeps;
  }
}
