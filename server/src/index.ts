import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authRequired, type Env } from './auth.js';
import { HttpError } from './util.js';
import { attachRealtime } from './realtime.js';
import { seed } from './seed.js';
import { authRoutes } from './routes/auth.js';
import { episodeRoutes } from './routes/episodes.js';
import { teamRoutes } from './routes/teams.js';
import { assignmentRoutes } from './routes/assignments.js';
import { progressRoutes } from './routes/progress.js';
import { ledgerRoutes } from './routes/ledger.js';
import { announcementRoutes } from './routes/announcements.js';
import { adminRoutes } from './routes/admin.js';
import { dashboardRoutes } from './routes/dashboard.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 3000);
const PUBLIC_DIR = process.env.PUBLIC_DIR ?? path.resolve(__dirname, '..', 'public');

const seeded = seed();
console.log(`[seed] hosts=${seeded.hosts.join(',')} episodes=${seeded.episodes} teams=${seeded.teams}`);

const app = new Hono<Env>();
app.use(logger());

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
  console.error(err);
  return c.json({ error: '服务器内部错误' }, 500);
});

const api = new Hono<Env>();
api.route('/auth', authRoutes);
api.get('/health', (c) => c.json({ ok: true, time: new Date().toISOString() }));

const secured = new Hono<Env>();
secured.use('*', authRequired);
secured.route('/', episodeRoutes);
secured.route('/', teamRoutes);
secured.route('/', assignmentRoutes);
secured.route('/', progressRoutes);
secured.route('/', ledgerRoutes);
secured.route('/', announcementRoutes);
secured.route('/', adminRoutes);
secured.route('/', dashboardRoutes);
api.route('/', secured);
app.route('/api', api);
app.notFound((c) => (c.req.path.startsWith('/api/') ? c.json({ error: '接口不存在' }, 404) : c.text('Not found', 404)));

// 静态前端（生产模式：web 构建产物复制到 server/public）
if (fs.existsSync(PUBLIC_DIR)) {
  const rel = path.relative(process.cwd(), PUBLIC_DIR);
  app.use('/*', serveStatic({ root: rel }));
  app.get('/*', (c) => {
    if (c.req.path.startsWith('/api/')) return c.notFound();
    return c.html(fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8'));
  });
}

const server = serve({ fetch: app.fetch, port: PORT, hostname: '0.0.0.0' }, (info) => {
  console.log(`CRP server listening on http://0.0.0.0:${info.port}  (public: ${fs.existsSync(PUBLIC_DIR) ? PUBLIC_DIR : 'none, dev mode'})`);
});
attachRealtime(server as any);
