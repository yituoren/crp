import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { compress } from 'hono/compress';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authRequired, eventContext, type Env } from './auth.js';
import { HttpError } from './util.js';
import { attachRealtime } from './realtime.js';
import { seed } from './seed.js';
import { startScheduler } from './scheduler.js';
import { authRoutes } from './routes/auth.js';
import { episodeRoutes } from './routes/episodes.js';
import { teamRoutes } from './routes/teams.js';
import { assignmentRoutes } from './routes/assignments.js';
import { progressRoutes } from './routes/progress.js';
import { ledgerRoutes } from './routes/ledger.js';
import { announcementRoutes } from './routes/announcements.js';
import { adminRoutes } from './routes/admin.js';
import { dashboardRoutes } from './routes/dashboard.js';
import { eventListRoutes, eventInfoRoutes } from './routes/events.js';
import { userRoutes, systemRoutes } from './routes/admin.js';
import { fileRoutes } from './routes/episodes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);
const PUBLIC_DIR = process.env.PUBLIC_DIR ?? path.resolve(__dirname, '..', 'public');

const seeded = seed();
console.log(`[seed] events=${seeded.events} episodes=${seeded.episodes} teams=${seeded.teams}`);

const app = new Hono<Env>();
app.use(logger());
app.use(compress()); // gzip/br: JSON and JS shrink to roughly a quarter
// hashed static assets can be cached forever
app.use('/assets/*', async (c, next) => {
  await next();
  c.header('Cache-Control', 'public, max-age=31536000, immutable');
});

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
  console.error('[error] unhandled:', err);
  return c.json({ error: '服务器内部错误' }, 500);
});

const api = new Hono<Env>();
api.route('/auth', authRoutes);
api.get('/health', (c) => c.json({ ok: true, time: new Date().toISOString() }));

// Before entering an event: event list / join, account management, system backups
const secured = new Hono<Env>();
secured.use('*', authRequired);
secured.route('/', eventListRoutes);
secured.route('/', userRoutes);
secured.route('/', systemRoutes);
secured.route('/', fileRoutes);
// Inside an event: /api/events/:hash/..., every data route hangs off the event
const inEvent = new Hono<Env>();
inEvent.use('*', eventContext);
inEvent.route('/', eventInfoRoutes);
inEvent.route('/', episodeRoutes);
inEvent.route('/', teamRoutes);
inEvent.route('/', assignmentRoutes);
inEvent.route('/', progressRoutes);
inEvent.route('/', ledgerRoutes);
inEvent.route('/', announcementRoutes);
inEvent.route('/', adminRoutes);
inEvent.route('/', dashboardRoutes);
secured.route('/events/:hash', inEvent);
api.route('/', secured);
app.route('/api', api);
app.notFound((c) => (c.req.path.startsWith('/api/') ? c.json({ error: '接口不存在' }, 404) : c.text('Not found', 404)));

// Static front end (production: the web build is copied into server/public)
if (fs.existsSync(PUBLIC_DIR)) {
  const rel = path.relative(process.cwd(), PUBLIC_DIR);
  app.use('/*', serveStatic({ root: rel }));
  app.get('/*', (c) => {
    if (c.req.path.startsWith('/api/')) return c.notFound();
    return c.html(fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8'));
  });
}

// '::' listens on IPv6 and, with bindv6only=0 (Linux default), IPv4 as well
const server = serve({ fetch: app.fetch, port: PORT, hostname: '::' }, (info) => {
  console.log(`[server] listening on http://[::]:${info.port} (static: ${fs.existsSync(PUBLIC_DIR) ? PUBLIC_DIR : 'none, dev mode'})`);
});
attachRealtime(server as any);
startScheduler();
