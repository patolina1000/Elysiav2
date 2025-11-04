const express = require('express');
const path = require('path');
const { Pool } = require('pg');

// --- Postgres minimal ---
let pgPool = null;
async function getPgPool() {
  if (pgPool !== null) return pgPool;
  const url = (process.env.DATABASE_URL || '').trim();
  if (!url) {
    console.warn('[PG] DATABASE_URL ausente — usando storage em memória.');
    pgPool = null;
    return null;
  }
  pgPool = new Pool({
    connectionString: url,
    max: 5,
    idleTimeoutMillis: 30_000,
    // Render Postgres geralmente exige SSL
    ssl: { rejectUnauthorized: false }
  });
  // sanity ping
  try {
    await pgPool.query('SELECT 1');
    console.info('[PG] conectado.');
  } catch (e) {
    console.error('[PG] falha ao conectar — fallback para memória.', e?.message);
    pgPool = null;
  }
  return pgPool;
}

/** Migração segura e idempotente da tabela public.bots */
async function ensureBotsTable() {
  const pool = await getPgPool();
  if (!pool) return false;
  const sql = `
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

CREATE TABLE IF NOT EXISTS public.bots (
  id          bigserial PRIMARY KEY,
  name        text      NOT NULL,
  slug        text      NOT NULL,
  provider    text      NOT NULL,
  use_album   boolean   NOT NULL DEFAULT false,
  token       text      NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public' AND indexname='ux_bots_slug'
  ) THEN
    EXECUTE 'CREATE UNIQUE INDEX ux_bots_slug ON public.bots(slug)';
  END IF;
END $$;

COMMIT;`;
  await pool.query(sql);
  console.info('[DB][MIGRATION][BOTS] ok');
  return true;
}

// --- ADMIN API: storage & helpers ---
const crypto = require('crypto');

const mem = {
  bots: new Map(), // key = slug, value = bot object
};

function genReqId() {
  return (Date.now().toString(36) + '-' + crypto.randomUUID()).toLowerCase();
}
function maskToken(t) {
  if (!t) return null;
  const s = String(t);
  return s.length <= 6 ? '***' : `${s.slice(0,3)}***${s.slice(-3)}`;
}
function getPublicBaseUrl(req) {
  const fromEnv = process.env.PUBLIC_BASE_URL && process.env.PUBLIC_BASE_URL.trim();
  if (fromEnv) return fromEnv.replace(/\/+$/, '');
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http');
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${proto}://${host}`;
}
// Defaults imutáveis (blueprint)
const IMMUTABLE_DEFAULTS = Object.freeze({
  rate_per_minute: 60,
  sandbox: false,
  renderer: 'MarkdownV2',
  typing_delay_ms: 0,
  watermark: null,
});

function validateBotPayload(body) {
  const errors = [];
  const name = (body?.name || '').toString().trim();
  const slug = (body?.slug || '').toString().trim().toLowerCase();
  const provider = (body?.provider || '').toString().trim().toLowerCase();
  const use_album = Boolean(body?.use_album);
  const token = (body?.token || '').toString().trim() || null;

  if (!name) errors.push('name is required');
  if (!slug || !/^[a-z0-9][a-z0-9_-]{1,63}$/.test(slug)) errors.push('slug invalid (use a-z, 0-9, -, _)');
  if (!provider) errors.push('provider is required');

  return { errors, name, slug, provider, use_album, token };
}

const app = express();
const PORT = process.env.PORT || 3000;
const publicDirectory = path.join(__dirname, 'public');

app.use(express.json());

// Migração segura no boot (rápida e idempotente)
ensureBotsTable().catch(err => {
  console.error('[DB][MIGRATION][BOTS] erro', err?.message);
});

// Lista bots (sem auth por enquanto)
app.get('/api/admin/bots', async (req, res) => {
  const request_id = genReqId();
  const publicBase = getPublicBaseUrl(req);
  const pool = await getPgPool();

  try {
    let list = [];
    if (pool) {
      const { rows } = await pool.query(`
        SELECT name, slug, provider, use_album,
               (token IS NOT NULL) AS has_token,
               created_at
        FROM public.bots
        ORDER BY created_at DESC
      `);
      list = rows.map(r => ({
        name: r.name,
        slug: r.slug,
        provider: r.provider,
        use_album: r.use_album,
        has_token: r.has_token,
        rate_per_minute: IMMUTABLE_DEFAULTS.rate_per_minute,
        sandbox:          IMMUTABLE_DEFAULTS.sandbox,
        renderer:         IMMUTABLE_DEFAULTS.renderer,
        typing_delay_ms:  IMMUTABLE_DEFAULTS.typing_delay_ms,
        watermark:        IMMUTABLE_DEFAULTS.watermark,
        webhook_url: `${publicBase}/tg/${encodeURIComponent(r.slug)}/webhook`,
        created_at: r.created_at
      }));
      console.info('[ADMIN_BOTS][LIST]', { request_id, count: list.length, store: 'pg' });
    } else {
      // fallback memória (do Prompt 1)
      list = Array.from(mem.bots.values()).map(b => ({
        name: b.name,
        slug: b.slug,
        provider: b.provider,
        use_album: b.use_album,
        has_token: !!b.token,
        rate_per_minute: b.rate_per_minute,
        sandbox: b.sandbox,
        renderer: b.renderer,
        typing_delay_ms: b.typing_delay_ms,
        watermark: b.watermark,
        webhook_url: b.webhook_url,
        created_at: b.created_at,
      }));
      console.info('[ADMIN_BOTS][LIST]', { request_id, count: list.length, store: 'mem' });
    }
    res.json(list);
  } catch (err) {
    console.error('[ADMIN_BOTS][LIST][ERR]', { request_id, err: err?.message });
    res.status(500).json({ ok: false, error: 'LIST_FAILED' });
  }
});

// Cria bot (sem auth por enquanto) + defaults imutáveis
app.post('/api/admin/bots', express.json(), async (req, res) => {
  const request_id = genReqId();
  const { errors, name, slug, provider, use_album, token } = validateBotPayload(req.body || {});
  if (errors.length) {
    console.warn('[ADMIN_BOTS][CREATE][INVALID]', { request_id, errors });
    return res.status(400).json({ ok: false, error: 'INVALID_PAYLOAD', details: errors });
  }

  const publicBase = getPublicBaseUrl(req);
  const webhook_url = `${publicBase}/tg/${encodeURIComponent(slug)}/webhook`;

  const pool = await getPgPool();

  try {
    if (pool) {
      // tenta inserir; se slug já existir, conflita
      const q = `
        INSERT INTO public.bots (name, slug, provider, use_album, token)
        VALUES ($1,$2,$3,$4,$5)
        ON CONFLICT (slug) DO NOTHING
        RETURNING name, slug, provider, use_album, (token IS NOT NULL) AS has_token, created_at
      `;
      const vals = [name, slug, provider, !!use_album, token || null];
      const r = await pool.query(q, vals);

      if (r.rows.length === 0) {
        console.warn('[ADMIN_BOTS][CREATE][CONFLICT]', { request_id, slug });
        return res.status(409).json({ ok: false, error: 'SLUG_ALREADY_EXISTS' });
      }

      const row = r.rows[0];

      console.info('[ADMIN_BOTS][CREATE][OK]', {
        request_id, slug, provider,
        use_album: row.use_album,
        has_token: row.has_token,
        token_masked: maskToken(token || ''),
        forced_defaults: IMMUTABLE_DEFAULTS,
        webhook_url
      });

      return res.status(201).json({
        ok: true,
        slug,
        webhook_url,
        bot: {
          name: row.name,
          slug: row.slug,
          provider: row.provider,
          use_album: row.use_album,
          has_token: row.has_token,
          rate_per_minute: IMMUTABLE_DEFAULTS.rate_per_minute,
          sandbox:          IMMUTABLE_DEFAULTS.sandbox,
          renderer:         IMMUTABLE_DEFAULTS.renderer,
          typing_delay_ms:  IMMUTABLE_DEFAULTS.typing_delay_ms,
          watermark:        IMMUTABLE_DEFAULTS.watermark,
          webhook_url,
          created_at: row.created_at
        }
      });
    }

    // fallback memória
    if (mem.bots.has(slug)) {
      console.warn('[ADMIN_BOTS][CREATE][CONFLICT]', { request_id, slug });
      return res.status(409).json({ ok: false, error: 'SLUG_ALREADY_EXISTS' });
    }

    const bot = {
      name, slug, provider, use_album: !!use_album,
      token: token || null,
      rate_per_minute: IMMUTABLE_DEFAULTS.rate_per_minute,
      sandbox:          IMMUTABLE_DEFAULTS.sandbox,
      renderer:         IMMUTABLE_DEFAULTS.renderer,
      typing_delay_ms:  IMMUTABLE_DEFAULTS.typing_delay_ms,
      watermark:        IMMUTABLE_DEFAULTS.watermark,
      webhook_url,
      created_at: new Date().toISOString(),
    };
    mem.bots.set(slug, bot);

    console.info('[ADMIN_BOTS][CREATE][OK]', {
      request_id, slug, provider,
      use_album: bot.use_album,
      has_token: !!bot.token,
      token_masked: maskToken(bot.token),
      forced_defaults: IMMUTABLE_DEFAULTS,
      webhook_url
    });

    const { token: _omit, ...safe } = bot;
    return res.status(201).json({ ok: true, slug, webhook_url, bot: { ...safe, has_token: !!bot.token } });
  } catch (err) {
    console.error('[ADMIN_BOTS][CREATE][ERR]', { request_id, err: err?.message });
    return res.status(500).json({ ok: false, error: 'CREATE_FAILED' });
  }
});

app.post('/api/telegram/validate-token', async (req, res) => {
  const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
  if (!token) {
    return res.status(400).json({ ok: false, error: 'TOKEN_REQUIRED' });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  const url = `https://api.telegram.org/bot${encodeURIComponent(token)}/getMe`;

  try {
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    const data = await response.json().catch(() => ({}));
    if (data && data.ok) {
      const { id, username, first_name } = data.result || {};
      return res.json({ ok: true, result: { id, username, first_name } });
    }
    const reason = (data && (data.description || data.error)) || 'INVALID_TOKEN';
    return res.status(400).json({ ok: false, error: reason });
  } catch (error) {
    clearTimeout(timeout);
    const message = error && error.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK';
    return res.status(502).json({ ok: false, error: message });
  }
});

app.use(express.static(publicDirectory, {
  extensions: ['html'],
  fallthrough: true
}));

app.get('/env.js', (_req, res) => {
  const appBaseUrl = process.env.APP_BASE_URL || '';
  const publicBaseUrl = process.env.PUBLIC_BASE_URL || '';

  res.type('application/javascript');
  res.send(`window.__ENV__ = Object.freeze({\n` +
    `  APP_BASE_URL: ${JSON.stringify(appBaseUrl)},\n` +
    `  PUBLIC_BASE_URL: ${JSON.stringify(publicBaseUrl)}\n` +
    `});\n`);
});

app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.includes('.')) {
    res.sendFile(path.join(publicDirectory, 'index.html'), (err) => {
      if (err) {
        next();
      }
    });
  } else {
    next();
  }
});

// ---- Health check para o Render (retorna 200 OK) ----
// Mantém resposta em texto simples para ser leve e previsível.
// Adicionar ANTES do app.listen(...)
app.get('/healthz', (_req, res) => {
  res.status(200).type('text/plain').send('ok');
});
// Alguns provedores usam HEAD no healthcheck; garanta 200 também:
app.head('/healthz', (_req, res) => res.sendStatus(200));

app.use((req, res) => {
  res.status(404).send('Not Found');
});

const HOST = '0.0.0.0';
app.listen(PORT, HOST, () => {
  console.log(`Servidor ouvindo na porta ${PORT}`);
});
