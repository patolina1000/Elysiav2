const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const crypto = require('crypto');
const requireAdmin = require('./middleware/requireAdmin');
const requireTgSecret = require('./middleware/requireTgSecret');
const { createQueue } = require('./lib/inMemoryQueue');
const { insertStartEvent } = require('./lib/funnel');
const { recordStartLatency } = require('./lib/metrics');

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

/** Migração segura e idempotente da tabela public.bots (compat com esquemas antigos) */
async function ensureBotsTable() {
  const pool = await getPgPool();
  if (!pool) return false;

  const sql = `
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- Base mínima
CREATE TABLE IF NOT EXISTS public.bots (
  id bigserial PRIMARY KEY
);

-- Garante colunas (idempotente)
ALTER TABLE public.bots ADD COLUMN IF NOT EXISTS name        text;
ALTER TABLE public.bots ADD COLUMN IF NOT EXISTS slug        text;
ALTER TABLE public.bots ADD COLUMN IF NOT EXISTS provider    text;
ALTER TABLE public.bots ADD COLUMN IF NOT EXISTS use_album   boolean;
ALTER TABLE public.bots ADD COLUMN IF NOT EXISTS token       text;
ALTER TABLE public.bots ADD COLUMN IF NOT EXISTS created_at  timestamptz;

-- Coluna legada (alguns ambientes têm token_encrypted NOT NULL)
ALTER TABLE public.bots ADD COLUMN IF NOT EXISTS token_encrypted bytea;

-- Defaults leves
ALTER TABLE public.bots ALTER COLUMN use_album  SET DEFAULT false;
UPDATE public.bots SET use_album = false WHERE use_album IS NULL;

ALTER TABLE public.bots ALTER COLUMN created_at SET DEFAULT now();
UPDATE public.bots SET created_at = now() WHERE created_at IS NULL;

-- Se token_encrypted existir e for NOT NULL, relaxa a restrição (token é opcional no blueprint)
DO $$
DECLARE nn boolean;
BEGIN
  SELECT (c.is_nullable = 'NO') INTO nn
  FROM information_schema.columns c
  WHERE c.table_schema='public' AND c.table_name='bots' AND c.column_name='token_encrypted';
  IF nn IS TRUE THEN
    EXECUTE 'ALTER TABLE public.bots ALTER COLUMN token_encrypted DROP NOT NULL';
  END IF;
END $$;

-- Índice único em slug
CREATE UNIQUE INDEX IF NOT EXISTS ux_bots_slug ON public.bots(slug);

COMMIT;`;
  await pool.query(sql);
  console.info('[DB][MIGRATION][BOTS] ok (compat token_encrypted)');
  return true;
}

// --- ADMIN API: storage & helpers ---

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
async function botsHasColumn(col) {
  const pool = await getPgPool();
  if (!pool) return false;
  const q = `
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='bots' AND column_name=$1
    LIMIT 1
  `;
  const r = await pool.query(q, [col]);
  return r.rowCount > 0;
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

// (Opcional, somente quando explicitamente habilitado)
if (process.env.ENABLE_BOOT_MIGRATION === 'true') {
  ensureBotsTable().catch(err => {
    console.error('[DB][MIGRATION][BOTS] erro', err?.message);
  });
}

// gerador simples de request_id
function rid() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`;
}

// worker assíncrono (por enquanto só loga)
const webhookQueue = createQueue(async (job) => {
  const t0 = Date.now();
  // Simular parsing/roteamento leve
  const { slug, update, request_id, received_at, t_ack } = job;
  const chatId = update?.message?.chat?.id || update?.callback_query?.message?.chat?.id || null;
  const kind = update?.message ? 'message' : update?.callback_query ? 'callback_query' : 'other';

  // Aqui no futuro: publicar Outbox, gravar st:/co: etc.
  console.info('[WEBHOOK:PROCESS]', { request_id, slug, kind, chatId, age_ms: Date.now() - received_at });

  // trabalho "rápido"
  await Promise.resolve();

  try {
    const msg = update && update.message;
    const text = (msg && typeof msg.text === 'string') ? msg.text.trim() : '';
    const messageChatId = msg && msg.chat && msg.chat.id ? String(msg.chat.id) : null;
    let latencyRecorded = false;

    const ensureStartLatency = () => {
      if (latencyRecorded || !t_ack) return;
      try {
        recordStartLatency(slug, Date.now() - t_ack);
        latencyRecorded = true;
      } catch (err) {
        console.error('[METRIC][START][ERR]', err?.message || err);
      }
    };

    if (!pgPool) {
      try {
        await getPgPool();
      } catch (err) {
        console.error('[WEBHOOK][PROCESS][PG][ERR]', err?.message || err);
      }
    }

    // 1) Detecta /start e grava st: direto na partição
    if (messageChatId && (text === '/start' || text.toLowerCase() === 'start' || text.startsWith('/start '))) {
      try {
        await insertStartEvent(pgPool, { slug, tg_id: messageChatId, occurredAt: new Date() });
      } catch (e) {
        console.error('[FUNNEL][START][ERR]', { slug, chatId: messageChatId, err: e?.message });
      }
    }

    // 2) (Se existir 1º envio real, posicione a métrica logo após o sendMessage)
    //    Exemplo com envio real (ajuste para sua função):
    //    const sent = await telegramSendMessage(botToken, chatId, texto, opts);
    //    if (sent) ensureStartLatency();

    // Fallback (mantém): se não houver envio implementado ainda, mede antes do DONE
    ensureStartLatency();
  } catch (err) {
    console.error('[WEBHOOK][PROCESS][ERR]', err?.message || err);
  }

  console.info('[WEBHOOK:DONE]', { request_id, slug, took_ms: Date.now() - t0 });
}, { name: 'webhook' });

// rota do webhook — ACK imediato
app.post('/tg/:slug/webhook', requireTgSecret, (req, res) => {
  const request_id = rid();
  const received_at = Date.now();
  const slug = (req.params.slug || '').trim();
  const update = req.body || {};

  // Logs mínimos (sem conteúdo sensível)
  console.info('[WEBHOOK:ACK]', { request_id, slug, has_update: !!update && Object.keys(update).length > 0 });

  // Enfileira para processamento assíncrono
  const t_ack = Date.now();
  webhookQueue.push({ request_id, received_at, slug, update, t_ack });

  // ACK IMEDIATO
  res.status(200).json({ ok: true });
});

// Lista bots (protegido por token Admin)
app.get('/api/admin/bots', requireAdmin, async (req, res) => {
  const request_id = genReqId();
  const publicBase = getPublicBaseUrl(req);
  const pool = await getPgPool();

  try {
    let list = [];
    if (pool) {
      const hasEnc = await botsHasColumn('token_encrypted');
      const sel = hasEnc
        ? `SELECT name, slug, provider, use_album,
                  ( (token IS NOT NULL) OR (token_encrypted IS NOT NULL) ) AS has_token,
                  created_at
             FROM public.bots
             ORDER BY created_at DESC`
        : `SELECT name, slug, provider, use_album,
                  (token IS NOT NULL) AS has_token,
                  created_at
             FROM public.bots
             ORDER BY created_at DESC`;

      const { rows } = await pool.query(sel);
      list = rows.map(r => ({
        name: r.name,
        slug: r.slug,
        provider: r.provider || 'unknown',
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
      // fallback memória
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

// Cria bot (protegido por token Admin) + defaults imutáveis
app.post('/api/admin/bots', requireAdmin, express.json(), async (req, res) => {
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
      // monta INSERT dinamicamente
      const hasEnc = await botsHasColumn('token_encrypted');
      const cols = ['name','slug','provider','use_album','token'];
      const placeholders = ['$1','$2','$3','$4','$5'];
      const vals = [name, slug, provider, !!use_album, token || null];

      // não setamos token_encrypted aqui (fica NULL) — agora é permitido
      const q = `
        INSERT INTO public.bots (${cols.join(',')})
        VALUES (${placeholders.join(',')})
        ON CONFLICT (slug) DO NOTHING
        RETURNING name, slug, provider, use_album,
                  ( (token IS NOT NULL) ${hasEnc ? 'OR (token_encrypted IS NOT NULL)' : ''} ) AS has_token,
                  created_at
      `;

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
