require('dotenv').config();
const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const crypto = require('crypto');
const { randomUUID } = require('crypto');
const dns = require('dns');
const pino = require('pino');
const requireAdmin = require('./middleware/requireAdmin');
const requireTgSecret = require('./middleware/requireTgSecret');
const { rateLimit, strictRateLimit } = require('./middleware/rateLimit');
const { createQueue } = require('./lib/inMemoryQueue');
const { insertStartEvent } = require('./lib/funnel');
const { recordStartLatency, observe } = require('./lib/metricsService');
const { saveTokenBySlug, getTokenBySlug, maskToken: maskBotToken } = require('./lib/tokenService');
const { sendMessage: sendTelegramMessage, getQueueMetrics } = require('./lib/queuedSend');
const { getMetrics: getSendMetrics } = require('./lib/sendService');
const { warmUp: warmUpTelegram } = require('./lib/telegramClient');
const queueManager = require('./lib/queueManager');
const heartbeat = require('./lib/heartbeat');
const { getStartMessages, prepareMessageForSend, getDefaultStartMessage } = require('./lib/botMessagesService');
const { scheduleDownsell, scheduleDownsellsForStart, scheduleDownsellsForPix, listDownsells, cancelDownsellsOnPayment, cancelDownsellsOnExpiration } = require('./lib/downsellService');
const downsellWorker = require('./lib/downsellWorker');
const downsellScheduler = require('./lib/downsellScheduler');
const shotWorker = require('./lib/shotWorker');

// Logger otimizado para hot paths
const log = pino({ level: process.env.LOG_LEVEL || 'info' });

// --- Network optimizations ---
// Priorizar IPv4 para evitar fallback demorado para IPv6
dns.setDefaultResultOrder('ipv4first');

// Configurar undici Agent global para keep-alive (Node.js 18+)
try {
  const { setGlobalDispatcher, Agent } = require('undici');
  setGlobalDispatcher(new Agent({
    connections: 100,
    pipelining: 1,
    keepAliveTimeout: 60_000,
    keepAliveMaxTimeout: 120_000,
  }));
  console.info('[NETWORK] undici global dispatcher configurado');
} catch (err) {
  console.warn('[NETWORK] undici não disponível, usando fetch padrão');
}

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
    max: 12,
    maxUses: 1000,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 30000, // 30s timeout para statements
    query_timeout: 30000,     // 30s timeout para queries
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

-- Colunas para token criptografado (AES-GCM)
ALTER TABLE public.bots ADD COLUMN IF NOT EXISTS token_encrypted text;
ALTER TABLE public.bots ADD COLUMN IF NOT EXISTS token_iv        text;
ALTER TABLE public.bots ADD COLUMN IF NOT EXISTS token_updated_at timestamptz;

-- Coluna para soft delete
ALTER TABLE public.bots ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- Defaults leves
ALTER TABLE public.bots ALTER COLUMN use_album  SET DEFAULT false;
UPDATE public.bots SET use_album = false WHERE use_album IS NULL;

ALTER TABLE public.bots ALTER COLUMN created_at SET DEFAULT now();
UPDATE public.bots SET created_at = now() WHERE created_at IS NULL;

-- Índice único em slug
CREATE UNIQUE INDEX IF NOT EXISTS ux_bots_slug ON public.bots(slug);

COMMIT;`;
  await pool.query(sql);
  console.info('[DB][MIGRATION][BOTS] ok (compat token_encrypted)');
  return true;
}

/** Migração segura e idempotente da tabela gateway_events */
async function ensureGatewayEventsTable() {
  const pool = await getPgPool();
  if (!pool) return false;

  const sql = `
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- Tabela de eventos de gateway (envios)
CREATE TABLE IF NOT EXISTS public.gateway_events (
  id bigserial PRIMARY KEY,
  request_id text NOT NULL,
  slug text NOT NULL,
  chat_id text NOT NULL,
  message_id bigint,
  status text NOT NULL,
  lat_ms integer,
  purpose text NOT NULL,
  dedupe_key text NOT NULL,
  error_code text,
  occurred_at timestamptz DEFAULT now()
);

-- Índice único para deduplicação
CREATE UNIQUE INDEX IF NOT EXISTS ux_gateway_events_dedupe ON public.gateway_events(dedupe_key);

-- Índices para consultas
CREATE INDEX IF NOT EXISTS ix_gateway_events_slug_purpose ON public.gateway_events(slug, purpose);
CREATE INDEX IF NOT EXISTS ix_gateway_events_occurred_at ON public.gateway_events(occurred_at DESC);

COMMIT;`;
  await pool.query(sql);
  console.info('[DB][MIGRATION][GATEWAY_EVENTS] ok');
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

// Helpers para respeitar X-Forwarded-* do ngrok/reverse proxies
function forwardedProto(req) {
  // ex: "https" ou "https, http" -> pega o primeiro
  const p = (req.get('x-forwarded-proto') || req.protocol || 'http').split(',')[0].trim();
  return p;
}

function forwardedHost(req) {
  return (req.get('x-forwarded-host') || req.get('host'));
}

function getPublicBase(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/+$/, '');
  const proto = forwardedProto(req);
  const host = forwardedHost(req);
  return `${proto}://${host}`;
}

// Alias para compatibilidade com código existente
function getPublicBaseUrl(req) {
  return getPublicBase(req);
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
app.set('trust proxy', true); // Para ngrok e X-Forwarded-* headers
const PORT = process.env.PORT || 3000;
const publicDirectory = path.join(__dirname, 'public');

// Aumentar limite para suportar uploads de imagens em base64 (50MB)
app.use(express.json({ limit: '50mb' }));

// Admin UI (arquivos estáticos)
const adminDirectory = path.join(publicDirectory, 'admin');
app.use('/admin', express.static(adminDirectory));
// SPA: qualquer subrota de /admin serve o index.html para o front roteá-la
app.get('/admin/*', (req, res) => {
  res.sendFile(path.join(adminDirectory, 'index.html'));
});

// (Opcional, somente quando explicitamente habilitado)
if (process.env.ENABLE_BOOT_MIGRATION === 'true') {
  ensureBotsTable().catch(err => {
    console.error('[DB][MIGRATION][BOTS] erro', err?.message);
  });
  ensureGatewayEventsTable().catch(err => {
    console.error('[DB][MIGRATION][GATEWAY_EVENTS] erro', err?.message);
  });
}

// gerador simples de request_id
function rid() {
  return crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2,8)}`;
}

/**
 * Processa update do webhook de forma assíncrona
 */
async function processUpdate({ slug, update, request_id, received_at }) {
  const t0 = Date.now();
  const start_enqueue_ms = t0 - received_at;
  const chatId = update?.message?.chat?.id || update?.callback_query?.message?.chat?.id || null;
  const kind = update?.message ? 'message' : update?.callback_query ? 'callback_query' : 'other';

  log.info({ request_id, slug, kind, chatId, start_enqueue_ms }, '[WEBHOOK:PROCESS]');

  try {
    const msg = update && update.message;
    const text = (msg && typeof msg.text === 'string') ? msg.text.trim() : '';
    const messageChatId = msg && msg.chat && msg.chat.id ? String(msg.chat.id) : null;

    if (!pgPool) {
      try {
        await getPgPool();
      } catch (err) {
        console.error('[WEBHOOK][PROCESS][PG][ERR]', err?.message || err);
      }
    }

    // Detecta /start - SEM DEDUPE (sempre enviar)
    if (messageChatId && (text === '/start' || text.toLowerCase() === 'start' || text.startsWith('/start '))) {
      const enqueueStart = Date.now();
      
      try {
        // Enviar mensagens configuradas (prioridade máxima)
        if (pgPool) {
          const startSessionId = `${messageChatId}_${Date.now()}`;
          
          // 1. Verificar se há mensagem personalizada simples (start_message)
          const { getStartMessage } = require('./lib/startMessageService');
          const startMessageConfig = await getStartMessage(pgPool, slug);
          
          let messages = [];
          let hasMedia = false;
          let mediaRefs = [];
          
          if (startMessageConfig.active && startMessageConfig.message) {
            // Usar mensagem personalizada simples
            console.info('[START][USING_CUSTOM_MESSAGE]', { slug });
            observe('start_config_used_total', 1, { bot: slug, active: true });
            
            // Verificar se há mídias configuradas (novo sistema)
            if (startMessageConfig.start_media_refs && startMessageConfig.start_media_refs.length > 0) {
              hasMedia = true;
              mediaRefs = startMessageConfig.start_media_refs;
              console.info('[START][WITH_MULTI_MEDIA]', { 
                slug, 
                media_count: mediaRefs.length,
                kinds: mediaRefs.map(m => m.kind).join(',')
              });
            }
            
            messages = [{
              message_type: 'text',
              content: startMessageConfig.message
            }];
          } else {
            // Registrar uso de fallback
            observe('start_config_used_total', 1, { bot: slug, active: false });
            // 2. Fallback: buscar mensagens configuradas antigas (bot_messages)
            try {
              messages = await getStartMessages(pgPool, slug);
            } catch (err) {
              console.warn('[START][GET_MESSAGES][ERR]', { slug, error: err.message });
            }
            
            // 3. Se não houver nenhuma configuração, usar fallback padrão
            if (messages.length === 0) {
              console.warn('[START][NO_MESSAGES_CONFIGURED]', { slug });
              messages = [getDefaultStartMessage()];
            }
          }
          
          // Enviar primeira mensagem e medir latência
          const sendStart = Date.now();
          let firstMessageSent = false;
          
          // Se há mídias, enviar as mídias primeiro (separadas, sem caption)
          if (hasMedia && mediaRefs.length > 0) {
            const { sendMultipleMedias } = require('./lib/multiMediaSendService');
            
            try {
              const mediaResult = await sendMultipleMedias(pgPool, {
                slug,
                chat_id: messageChatId,
                media_refs: mediaRefs,
                purpose: 'start'
              });
              
              if (mediaResult.ok) {
                firstMessageSent = true;
                console.info('[START][MULTI_MEDIA_SENT]', {
                  slug,
                  chat_id: messageChatId,
                  media_count: mediaRefs.length,
                  success_count: mediaResult.summary.success,
                  total_ms: mediaResult.total_ms
                });
              } else {
                console.warn('[START][MULTI_MEDIA_FAILED]', {
                  slug,
                  chat_id: messageChatId,
                  media_count: mediaRefs.length,
                  errors: mediaResult.summary.errors
                });
              }
            } catch (err) {
              console.error('[START][MULTI_MEDIA_ERR]', {
                slug,
                chat_id: messageChatId,
                error: err.message
              });
            }
          }
          
          // Enviar mensagens de texto (após as mídias, se houver)
          for (let i = 0; i < messages.length; i++) {
            const message = prepareMessageForSend(messages[i]);
            
            const result = await sendTelegramMessage(pgPool, {
              slug,
              chat_id: messageChatId,
              text: message.text,
              parse_mode: message.parse_mode || 'MarkdownV2',
              disable_web_page_preview: message.disable_web_page_preview !== false,
              raw: message.raw || false,
              purpose: 'start',
              request_id: `start_${request_id}_${i}`,
              start_session_id: startSessionId
            });
            
            if (result.ok) {
              console.info('[START][SEND][OK]', {
                slug,
                chat_id: messageChatId,
                message_id: result.message_id,
                sequence: i + 1,
                lat_ms: result.lat_ms,
                telegram_http_ms: result.telegram_lat_ms,
                queue_wait_ms: result.queue_wait_ms || 0
              });
              
              // Registrar métrica de latência apenas da primeira mensagem
              if (!firstMessageSent) {
                const totalLatency = Date.now() - sendStart;
                recordStartLatency(slug, totalLatency);
                observe('start_first_send_latency_ms', totalLatency, { bot: slug });
                firstMessageSent = true;
              }
            } else {
              console.error('[START][SEND][ERR]', {
                slug,
                chat_id: messageChatId,
                error: result.error,
                lat_ms: result.lat_ms
              });
            }
          }
          
          // Métricas finais
          const totalEnqueueLat = Date.now() - enqueueStart;
          observe('start_enqueue_total_ms', totalEnqueueLat, { bot: slug });
          
          console.info('[START][ENQUEUE_COMPLETE]', {
            request_id,
            slug,
            chat_id: messageChatId,
            total_enqueue_ms: totalEnqueueLat,
            media_sent: hasMedia ? mediaRefs.length : 0,
            text_messages: messages.length
          });
          
          // Agendar downsells ativos após /start (em background)
          setImmediate(async () => {
            try {
              const scheduled = await scheduleDownsellsForStart(pgPool, {
                bot_slug: slug,
                telegram_id: parseInt(messageChatId, 10),
                correlation_id: request_id,
                now: new Date()
              });
              
              if (scheduled > 0) {
                console.info('[START][DOWNSELLS_SCHEDULED]', { slug, count: scheduled });
              }
            } catch (err) {
              console.error('[START][SCHEDULE_DOWNSELL][ERR]', { slug, error: err.message });
            }
          });
        }
        
        // Gravar evento de funil (não bloqueia envio) - em background
        setImmediate(() => {
          insertStartEvent(pgPool, { slug, tg_id: messageChatId, occurredAt: new Date() })
            .then(funnelResult => {
              const funnel_insert_ms = Date.now() - enqueueStart;
              observe('start_funnel_insert_ms', funnel_insert_ms, { bot: slug });
              console.debug('[START][FUNNEL][OK]', {
                slug,
                chat_id: messageChatId,
                event_id: funnelResult.event_id,
                dedup: funnelResult.dedup,
                funnel_insert_ms
              });
            })
            .catch(e => {
              console.error('[FUNNEL][START][ERR]', { slug, chatId: messageChatId, err: e?.message });
            });
        });
      } catch (e) {
        console.error('[START][ERR]', { slug, chatId: messageChatId, err: e?.message });
      }
    }
  } catch (err) {
    console.error('[WEBHOOK][PROCESS][ERR]', err?.message || err);
  }

  const done_ms = Date.now() - t0;
  observe('webhook_done_ms', done_ms, { bot: slug });
  console.info('[WEBHOOK:DONE]', { request_id, slug, done_ms });
}

// rota do webhook — Fast-path com ACK imediato (SEM async)
app.post('/tg/:slug/webhook', requireTgSecret, (req, res) => {
  const started = Date.now();
  const request_id = randomUUID();
  const slug = (req.params.slug || '').trim();
  
  // Validar formato do slug (proteção contra path traversal)
  if (!slug || !/^[a-z0-9][a-z0-9_-]{1,63}$/i.test(slug)) {
    observe('webhook_invalid_slug', 1, { slug });
    log.warn({ request_id, slug }, '[WEBHOOK][INVALID_SLUG]');
    return res.status(400).end();
  }
  
  const update = req.body;

  // ACK IMEDIATO (fast-path) - ANTES de qualquer I/O (sem JSON para ser mais rápido)
  res.status(200).end();
  
  // Métrica de ACK (deve ser ~1-5ms)
  const ack_ms = Date.now() - started;
  observe('webhook_ack_ms', ack_ms, { bot: slug });
  log.info({ request_id, slug, ack_ms }, '[WEBHOOK][ACK_MS]');

  // Processar em background com setImmediate (não bloqueia event loop)
  setImmediate(async () => {
    try {
      await processUpdate({ slug, update, request_id, received_at: started });
    } catch (err) {
      log.error({ request_id, slug, err: String(err) }, '[WEBHOOK][BG_ERR]');
    }
  });
});

// Lista bots (protegido por token Admin + rate limit)
app.get('/api/admin/bots', rateLimit, requireAdmin, async (req, res) => {
  const request_id = genReqId();
  const publicBase = getPublicBaseUrl(req);
  const pool = await getPgPool();

  try {
    let list = [];
    if (pool) {
      const sel = `SELECT name, slug, provider, use_album,
                  (token_encrypted IS NOT NULL AND token_iv IS NOT NULL) AS has_token,
                  token_updated_at,
                  created_at
             FROM public.bots
             WHERE deleted_at IS NULL
             ORDER BY created_at DESC`;

      const { rows } = await pool.query(sel);
      list = rows.map(r => ({
        name: r.name,
        slug: r.slug,
        provider: r.provider || 'unknown',
        use_album: r.use_album,
        has_token: r.has_token,
        token_updated_at: r.token_updated_at,
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

// Cria bot (protegido por token Admin + strict rate limit) + defaults imutáveis
app.post('/api/admin/bots', strictRateLimit, requireAdmin, async (req, res) => {
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

// Endpoint: Salvar token criptografado de um bot (strict rate limit - sensível)
app.put('/api/admin/bots/:slug/token', strictRateLimit, requireAdmin, async (req, res) => {
  const request_id = genReqId();
  const slug = (req.params.slug || '').trim();
  const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';

  if (!slug) {
    console.warn('[ADMIN_BOT_TOKEN][PUT][INVALID]', { request_id, error: 'MISSING_SLUG' });
    return res.status(400).json({ ok: false, error: 'MISSING_SLUG' });
  }

  if (!token) {
    console.warn('[ADMIN_BOT_TOKEN][PUT][INVALID]', { request_id, slug, error: 'MISSING_TOKEN' });
    return res.status(400).json({ ok: false, error: 'MISSING_TOKEN' });
  }

  const pool = await getPgPool();
  if (!pool) {
    console.error('[ADMIN_BOT_TOKEN][PUT][ERR]', { request_id, slug, error: 'DATABASE_NOT_AVAILABLE' });
    return res.status(503).json({ ok: false, error: 'DATABASE_NOT_AVAILABLE' });
  }

  try {
    const result = await saveTokenBySlug(pool, slug, token);
    console.info('[ADMIN_BOT_TOKEN][PUT][OK]', {
      request_id,
      slug,
      token_masked: result.token_masked,
      token_updated_at: result.token_updated_at
    });
    
    // Warm-up e iniciar heartbeat (não bloqueia resposta)
    setImmediate(() => {
      warmUpTelegram(token).catch(err => {
        console.warn('[WARMUP][AFTER_TOKEN_SAVE]', { slug, error: err.message });
      });
      
      // Iniciar heartbeat HTTP para este bot (com error handling)
      try {
        heartbeat.startHttpHeartbeat(slug, token);
      } catch (err) {
        console.error('[HEARTBEAT][START][ERR]', { slug, error: err.message });
      }
    });
    
    return res.json(result);
  } catch (err) {
    const errorCode = err.message || 'SAVE_FAILED';
    console.error('[ADMIN_BOT_TOKEN][PUT][ERR]', {
      request_id,
      slug,
      error: errorCode,
      message: err.message
    });
    
    if (errorCode === 'ENCRYPTION_KEY_NOT_SET') {
      return res.status(500).json({ ok: false, error: 'ENCRYPTION_KEY_NOT_SET' });
    }
    if (errorCode === 'BOT_NOT_FOUND') {
      return res.status(404).json({ ok: false, error: 'BOT_NOT_FOUND' });
    }
    return res.status(500).json({ ok: false, error: errorCode });
  }
});

// Endpoint: Validar token do bot via API do Telegram
app.get('/api/admin/bots/:slug/token/status', requireAdmin, async (req, res) => {
  const request_id = genReqId();
  const slug = (req.params.slug || '').trim();

  if (!slug) {
    console.warn('[ADMIN_BOT_TOKEN][STATUS][INVALID]', { request_id, error: 'MISSING_SLUG' });
    return res.status(400).json({ ok: false, error: 'MISSING_SLUG' });
  }

  const pool = await getPgPool();
  if (!pool) {
    console.error('[ADMIN_BOT_TOKEN][STATUS][ERR]', { request_id, slug, error: 'DATABASE_NOT_AVAILABLE' });
    return res.status(503).json({ ok: false, error: 'DATABASE_NOT_AVAILABLE' });
  }

  try {
    const token = await getTokenBySlug(pool, slug);
    
    if (!token) {
      console.warn('[ADMIN_BOT_TOKEN][STATUS][NO_TOKEN]', { request_id, slug });
      return res.json({ ok: false, error: 'NO_TOKEN_CONFIGURED' });
    }

    // Validar token via API do Telegram
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const url = `https://api.telegram.org/bot${encodeURIComponent(token)}/getMe`;

    try {
      const response = await fetch(url, { signal: controller.signal });
      clearTimeout(timeout);
      const data = await response.json().catch(() => ({}));

      if (data && data.ok) {
        const { id, username, can_join_groups, can_read_all_group_messages } = data.result || {};
        console.info('[ADMIN_BOT_TOKEN][STATUS][OK]', {
          request_id,
          slug,
          bot_id: id,
          username
        });
        return res.json({
          ok: true,
          bot_id: id,
          username,
          can_join_groups,
          can_read_all_group_messages
        });
      }

      const reason = (data && (data.description || data.error)) || 'INVALID_TOKEN';
      console.warn('[ADMIN_BOT_TOKEN][STATUS][TELEGRAM_ERROR]', {
        request_id,
        slug,
        error: reason
      });
      return res.json({ ok: false, error: reason });
    } catch (error) {
      clearTimeout(timeout);
      const message = error && error.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR';
      console.error('[ADMIN_BOT_TOKEN][STATUS][FETCH_ERR]', {
        request_id,
        slug,
        error: message
      });
      return res.json({ ok: false, error: 'TELEGRAM_GETME_FAILED', details: message });
    }
  } catch (err) {
    const errorCode = err.message || 'STATUS_FAILED';
    console.error('[ADMIN_BOT_TOKEN][STATUS][ERR]', {
      request_id,
      slug,
      error: errorCode
    });
    
    if (errorCode === 'BOT_NOT_FOUND') {
      return res.status(404).json({ ok: false, error: 'BOT_NOT_FOUND' });
    }
    if (errorCode === 'ENCRYPTION_KEY_NOT_SET') {
      return res.status(500).json({ ok: false, error: 'ENCRYPTION_KEY_NOT_SET' });
    }
    return res.status(500).json({ ok: false, error: errorCode });
  }
});

// Endpoint: Obter detalhes de um bot específico (rate limit)
app.get('/api/admin/bots/:slug', rateLimit, requireAdmin, async (req, res) => {
  const request_id = genReqId();
  const slug = (req.params.slug || '').trim();
  const publicBase = getPublicBaseUrl(req);

  if (!slug) {
    console.warn('[ADMIN_BOT][GET][INVALID]', { request_id, error: 'MISSING_SLUG' });
    return res.status(400).json({ ok: false, error: 'MISSING_SLUG' });
  }

  const pool = await getPgPool();

  try {
    if (pool) {
      const query = `
        SELECT name, slug, provider, use_album,
               (token_encrypted IS NOT NULL AND token_iv IS NOT NULL) AS has_token,
               token_updated_at,
               created_at,
               deleted_at
        FROM public.bots
        WHERE slug = $1
      `;
      const result = await pool.query(query, [slug]);

      if (result.rowCount === 0) {
        console.warn('[ADMIN_BOT][GET][NOT_FOUND]', { request_id, slug });
        return res.status(404).json({ ok: false, error: 'BOT_NOT_FOUND' });
      }

      const row = result.rows[0];
      
      // Verificar se bot foi deletado
      if (row.deleted_at) {
        console.warn('[ADMIN_BOT][GET][DELETED]', { request_id, slug, deleted_at: row.deleted_at });
        return res.status(410).json({ ok: false, error: 'BOT_DELETED' });
      }
      
      const bot = {
        name: row.name,
        slug: row.slug,
        provider: row.provider || 'unknown',
        use_album: row.use_album,
        has_token: row.has_token,
        token_updated_at: row.token_updated_at,
        token_masked: row.has_token ? '***configured***' : null,
        rate_per_minute: IMMUTABLE_DEFAULTS.rate_per_minute,
        sandbox: IMMUTABLE_DEFAULTS.sandbox,
        renderer: IMMUTABLE_DEFAULTS.renderer,
        typing_delay_ms: IMMUTABLE_DEFAULTS.typing_delay_ms,
        watermark: IMMUTABLE_DEFAULTS.watermark,
        webhook_url: `${publicBase}/tg/${encodeURIComponent(row.slug)}/webhook`,
        created_at: row.created_at
      };

      console.info('[ADMIN_BOT][GET][OK]', { request_id, slug, has_token: bot.has_token });
      return res.json(bot);
    }

    // Fallback memória
    const bot = mem.bots.get(slug);
    if (!bot) {
      console.warn('[ADMIN_BOT][GET][NOT_FOUND]', { request_id, slug, store: 'mem' });
      return res.status(404).json({ ok: false, error: 'BOT_NOT_FOUND' });
    }

    const { token: _omit, ...safe } = bot;
    console.info('[ADMIN_BOT][GET][OK]', { request_id, slug, store: 'mem' });
    return res.json({ ...safe, has_token: !!bot.token });
  } catch (err) {
    console.error('[ADMIN_BOT][GET][ERR]', { request_id, slug, err: err?.message });
    return res.status(500).json({ ok: false, error: 'GET_FAILED' });
  }
});

// Endpoint: Deletar bot (soft delete por padrão, hard delete com ?hard=1) (strict rate limit)
app.delete('/api/admin/bots/:slug', strictRateLimit, requireAdmin, async (req, res) => {
  const request_id = genReqId();
  const slug = (req.params.slug || '').trim();
  const hardDelete = req.query.hard === '1';

  if (!slug) {
    console.warn('[ADMIN_BOT][DELETE][INVALID]', { request_id, error: 'MISSING_SLUG' });
    return res.status(400).json({ ok: false, error: 'MISSING_SLUG' });
  }

  const pool = await getPgPool();

  try {
    if (pool) {
      if (hardDelete) {
        // Hard delete COMPLETO - remove TODOS os dados do bot
        console.info('[ADMIN_BOT][DELETE][HARD][START]', { request_id, slug });
        
        // Buscar bot_id antes de deletar
        const botQuery = 'SELECT id FROM public.bots WHERE slug = $1';
        const botResult = await pool.query(botQuery, [slug]);
        
        if (botResult.rowCount === 0) {
          console.warn('[ADMIN_BOT][DELETE][NOT_FOUND]', { request_id, slug });
          return res.status(404).json({ ok: false, error: 'BOT_NOT_FOUND' });
        }
        
        const botId = botResult.rows[0].id;
        const deletedTables = {};
        
        try {
          // 1. Deletar shots_queue
          const shotsQueueResult = await pool.query('DELETE FROM public.shots_queue WHERE slug = $1', [slug]);
          deletedTables.shots_queue = shotsQueueResult.rowCount;
          
          // 2. Deletar shots
          const shotsResult = await pool.query('DELETE FROM public.shots WHERE slug = $1', [slug]);
          deletedTables.shots = shotsResult.rowCount;
          
          // 3. Deletar downsells_queue
          const downsellsQueueResult = await pool.query('DELETE FROM public.downsells_queue WHERE slug = $1', [slug]);
          deletedTables.downsells_queue = downsellsQueueResult.rowCount;
          
          // 4. Deletar bot_downsells
          const downsellsResult = await pool.query('DELETE FROM public.bot_downsells WHERE slug = $1', [slug]);
          deletedTables.bot_downsells = downsellsResult.rowCount;
          
          // 5. Deletar bot_messages
          const messagesResult = await pool.query('DELETE FROM public.bot_messages WHERE slug = $1', [slug]);
          deletedTables.bot_messages = messagesResult.rowCount;
          
          // 6. Deletar gateway_events
          const gatewayResult = await pool.query('DELETE FROM public.gateway_events WHERE slug = $1', [slug]);
          deletedTables.gateway_events = gatewayResult.rowCount;
          
          // 7. Deletar funnel_events (tentar tanto na tabela normal quanto nas partições)
          try {
            const funnelResult = await pool.query('DELETE FROM public.funnel_events WHERE bot_slug = $1', [slug]);
            deletedTables.funnel_events = funnelResult.rowCount;
          } catch (funnelErr) {
            console.warn('[ADMIN_BOT][DELETE][HARD][FUNNEL_SKIP]', { request_id, slug, error: funnelErr.message });
            deletedTables.funnel_events = 0;
          }
          
          // 8. Deletar payments relacionados ao bot (se existir a coluna bot_slug ou bot_id)
          try {
            const paymentsResult = await pool.query('DELETE FROM public.payments WHERE bot_slug = $1 OR bot_id = $2', [slug, botId]);
            deletedTables.payments = paymentsResult.rowCount;
          } catch (paymentsErr) {
            console.warn('[ADMIN_BOT][DELETE][HARD][PAYMENTS_SKIP]', { request_id, slug, error: paymentsErr.message });
            deletedTables.payments = 0;
          }
          
          // 9. Finalmente, deletar o próprio bot
          const botDeleteResult = await pool.query('DELETE FROM public.bots WHERE slug = $1 RETURNING slug, name', [slug]);
          
          if (botDeleteResult.rowCount === 0) {
            console.warn('[ADMIN_BOT][DELETE][HARD][BOT_NOT_DELETED]', { request_id, slug });
            return res.status(500).json({ ok: false, error: 'BOT_DELETE_FAILED' });
          }
          
          const deletedBot = botDeleteResult.rows[0];
          
          console.info('[ADMIN_BOT][DELETE][HARD][OK]', { 
            request_id, 
            slug, 
            bot_name: deletedBot.name,
            deleted_records: deletedTables 
          });
          
          return res.json({ 
            ok: true, 
            deleted: true, 
            hard: true,
            bot: deletedBot,
            deleted_records: deletedTables
          });
          
        } catch (err) {
          console.error('[ADMIN_BOT][DELETE][HARD][ERROR]', { request_id, slug, error: err.message, deleted_so_far: deletedTables });
          throw err;
        }
        
      } else {
        // Soft delete - marcar deleted_at
        const updateQuery = `
          UPDATE public.bots
          SET deleted_at = now()
          WHERE slug = $1 AND deleted_at IS NULL
          RETURNING slug, deleted_at
        `;
        const result = await pool.query(updateQuery, [slug]);

        if (result.rowCount === 0) {
          console.warn('[ADMIN_BOT][DELETE][NOT_FOUND]', { request_id, slug });
          return res.status(404).json({ ok: false, error: 'BOT_NOT_FOUND' });
        }

        const row = result.rows[0];
        console.info('[ADMIN_BOT][DELETE][SOFT][OK]', { request_id, slug, deleted_at: row.deleted_at });
        return res.json({ ok: true, deleted: true, soft: true, deleted_at: row.deleted_at });
      }
    }

    // Fallback memória
    if (!mem.bots.has(slug)) {
      console.warn('[ADMIN_BOT][DELETE][NOT_FOUND]', { request_id, slug, store: 'mem' });
      return res.status(404).json({ ok: false, error: 'BOT_NOT_FOUND' });
    }

    mem.bots.delete(slug);
    console.info('[ADMIN_BOT][DELETE][OK]', { request_id, slug, store: 'mem' });
    return res.json({ ok: true, deleted: true });
  } catch (err) {
    console.error('[ADMIN_BOT][DELETE][ERR]', { request_id, slug, err: err?.message });
    return res.status(500).json({ ok: false, error: 'DELETE_FAILED' });
  }
});

// Endpoint: Enviar mensagem de teste (strict rate limit)
app.post('/api/admin/bots/:slug/send-test', strictRateLimit, requireAdmin, async (req, res) => {
  const request_id = genReqId();
  const slug = (req.params.slug || '').trim();
  const { chat_id, text } = req.body || {};

  if (!slug) {
    console.warn('[SEND_TEST][INVALID]', { request_id, error: 'MISSING_SLUG' });
    return res.status(400).json({ ok: false, error: 'MISSING_SLUG' });
  }

  if (!chat_id) {
    console.warn('[SEND_TEST][INVALID]', { request_id, slug, error: 'MISSING_CHAT_ID' });
    return res.status(400).json({ ok: false, error: 'MISSING_CHAT_ID' });
  }

  if (!text || typeof text !== 'string' || !text.trim()) {
    console.warn('[SEND_TEST][INVALID]', { request_id, slug, error: 'MISSING_TEXT' });
    return res.status(400).json({ ok: false, error: 'MISSING_TEXT' });
  }

  const pool = await getPgPool();
  if (!pool) {
    console.error('[SEND_TEST][ERR]', { request_id, slug, error: 'DATABASE_NOT_AVAILABLE' });
    return res.status(503).json({ ok: false, error: 'DATABASE_NOT_AVAILABLE' });
  }

  try {
    console.info('[SEND_TEST][START]', {
      request_id,
      slug,
      chat_id,
      text_len: text.length
    });

    const result = await sendTelegramMessage(pool, {
      slug,
      chat_id,
      text: text.trim(),
      purpose: 'send-test',
      request_id
    });

    if (result.ok) {
      console.info('[SEND_TEST][OK]', {
        request_id,
        slug,
        chat_id,
        message_id: result.message_id,
        lat_ms: result.lat_ms,
        dedupe_applied: result.dedupe_applied || false
      });

      return res.json({
        ok: true,
        message_id: result.message_id,
        lat_ms: result.lat_ms,
        telegram_lat_ms: result.telegram_lat_ms,
        dedupe_applied: result.dedupe_applied || false
      });
    } else {
      console.error('[SEND_TEST][ERR]', {
        request_id,
        slug,
        chat_id,
        error: result.error,
        lat_ms: result.lat_ms
      });

      return res.status(400).json({
        ok: false,
        error: result.error,
        description: result.description,
        lat_ms: result.lat_ms
      });
    }
  } catch (err) {
    console.error('[SEND_TEST][EXCEPTION]', {
      request_id,
      slug,
      chat_id,
      error: err.message
    });

    return res.status(500).json({
      ok: false,
      error: 'INTERNAL_ERROR',
      description: err.message
    });
  }
});

// ========== ENDPOINTS DE MENSAGENS DO /START ==========

// Listar mensagens do /start de um bot
app.get('/api/admin/bots/:slug/messages', requireAdmin, async (req, res) => {
  const request_id = genReqId();
  const slug = (req.params.slug || '').trim();
  
  if (!slug) {
    return res.status(400).json({ ok: false, error: 'MISSING_SLUG' });
  }
  
  const pool = await getPgPool();
  if (!pool) {
    return res.status(503).json({ ok: false, error: 'DATABASE_NOT_AVAILABLE' });
  }
  
  try {
    const messages = await getStartMessages(pool, slug);
    console.info('[ADMIN][MESSAGES][LIST]', { request_id, slug, count: messages.length });
    return res.json({ ok: true, messages });
  } catch (err) {
    console.error('[ADMIN][MESSAGES][LIST][ERR]', { request_id, slug, error: err.message });
    return res.status(500).json({ ok: false, error: 'LIST_FAILED' });
  }
});

// Criar/atualizar mensagem do /start
app.post('/api/admin/bots/:slug/messages', requireAdmin, async (req, res) => {
  const request_id = genReqId();
  const slug = (req.params.slug || '').trim();
  const { sequence_order, message_type, content, active } = req.body || {};
  
  if (!slug) {
    return res.status(400).json({ ok: false, error: 'MISSING_SLUG' });
  }
  
  const pool = await getPgPool();
  if (!pool) {
    return res.status(503).json({ ok: false, error: 'DATABASE_NOT_AVAILABLE' });
  }
  
  try {
    const { upsertStartMessage } = require('./lib/botMessagesService');
    const message = await upsertStartMessage(pool, {
      slug,
      sequence_order,
      message_type,
      content,
      active
    });
    
    console.info('[ADMIN][MESSAGES][CREATE]', { request_id, slug, message_id: message.id });
    return res.status(201).json({ ok: true, message });
  } catch (err) {
    console.error('[ADMIN][MESSAGES][CREATE][ERR]', { request_id, slug, error: err.message });
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ========== ENDPOINTS DE MENSAGEM INICIAL DO /START (SIMPLES) ==========

const startMessageService = require('./lib/startMessageService');

// GET /api/admin/bots/:slug/start-message - Obter mensagem inicial
app.get('/api/admin/bots/:slug/start-message', requireAdmin, async (req, res) => {
  const request_id = genReqId();
  const slug = (req.params.slug || '').trim();

  if (!slug) {
    return res.status(400).json({ ok: false, error: 'SLUG_REQUIRED' });
  }

  try {
    const pool = await getPgPool();
    const data = await startMessageService.getStartMessage(pool, slug);
    console.info('[ADMIN][START_MESSAGE][GET]', { request_id, slug, active: data.active });
    return res.json({ ok: true, ...data });
  } catch (err) {
    console.error('[ADMIN][START_MESSAGE][GET][ERR]', { request_id, slug, error: err.message });
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// PUT /api/admin/bots/:slug/start-message - Salvar mensagem inicial
app.put('/api/admin/bots/:slug/start-message', requireAdmin, async (req, res) => {
  const request_id = genReqId();
  const slug = (req.params.slug || '').trim();
  const { active, message, start_media_refs } = req.body || {};

  if (!slug) {
    return res.status(400).json({ ok: false, error: 'SLUG_REQUIRED' });
  }

  try {
    const pool = await getPgPool();
    const data = await startMessageService.saveStartMessage(pool, slug, { active, message, start_media_refs });
    console.info('[ADMIN][START_MESSAGE][SAVE]', { request_id, slug, active: data.active, media_count: start_media_refs?.length || 0 });
    return res.json({ ok: true, ...data });
  } catch (err) {
    console.error('[ADMIN][START_MESSAGE][SAVE][ERR]', { request_id, slug, error: err.message });
    
    // Erros específicos
    if (err.message === 'MESSAGE_REQUIRED_WHEN_ACTIVE') {
      return res.status(400).json({ ok: false, error: 'MESSAGE_REQUIRED_WHEN_ACTIVE' });
    }
    if (err.message === 'MESSAGE_TEXT_REQUIRED') {
      return res.status(400).json({ ok: false, error: 'MESSAGE_TEXT_REQUIRED' });
    }
    if (err.message === 'MESSAGE_TEXT_TOO_LONG') {
      return res.status(400).json({ ok: false, error: 'MESSAGE_TEXT_TOO_LONG' });
    }
    if (err.message === 'ONLY_MARKDOWNV2_SUPPORTED') {
      return res.status(400).json({ ok: false, error: 'ONLY_MARKDOWNV2_SUPPORTED' });
    }
    if (err.message === 'BOT_NOT_FOUND') {
      return res.status(404).json({ ok: false, error: 'BOT_NOT_FOUND' });
    }
    if (err.message === 'START_MEDIA_REFS_MUST_BE_ARRAY') {
      return res.status(400).json({ ok: false, error: 'START_MEDIA_REFS_MUST_BE_ARRAY' });
    }
    if (err.message === 'START_MEDIA_REFS_MAX_3') {
      return res.status(400).json({ ok: false, error: 'START_MEDIA_REFS_MAX_3' });
    }
    if (err.message === 'INVALID_MEDIA_SHA256') {
      return res.status(400).json({ ok: false, error: 'INVALID_MEDIA_SHA256' });
    }
    if (err.message === 'INVALID_MEDIA_KIND') {
      return res.status(400).json({ ok: false, error: 'INVALID_MEDIA_KIND' });
    }
    
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// POST /api/admin/bots/:slug/start-message:test - Testar mensagem
app.post('/api/admin/bots/:slug/start-message:test', requireAdmin, async (req, res) => {
  const request_id = genReqId();
  const slug = (req.params.slug || '').trim();
  const { chat_id, message } = req.body || {};

  if (!slug) {
    return res.status(400).json({ ok: false, error: 'SLUG_REQUIRED' });
  }

  if (!chat_id) {
    return res.status(400).json({ ok: false, error: 'CHAT_ID_REQUIRED' });
  }

  try {
    const pool = await getPgPool();
    const result = await startMessageService.testStartMessage(pool, slug, chat_id, message);
    console.info('[ADMIN][START_MESSAGE][TEST]', { request_id, slug, chat_id, ...result });
    return res.json({ ok: true, ...result });
  } catch (err) {
    console.error('[ADMIN][START_MESSAGE][TEST][ERR]', { request_id, slug, chat_id, error: err.message });
    
    if (err.message === 'MESSAGE_TEXT_REQUIRED') {
      return res.status(400).json({ ok: false, error: 'MESSAGE_TEXT_REQUIRED' });
    }
    if (err.message === 'MESSAGE_TEXT_TOO_LONG') {
      return res.status(400).json({ ok: false, error: 'MESSAGE_TEXT_TOO_LONG' });
    }
    
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// Registrar endpoints de downsells e disparos
const { registerDownsellEndpoints, registerShotEndpoints } = require('./lib/adminEndpoints');
registerDownsellEndpoints(app, requireAdmin, getPgPool);
registerShotEndpoints(app, requireAdmin, getPgPool);

// Endpoint: Obter métricas de envio (legado)
app.get('/api/admin/metrics/send', requireAdmin, async (req, res) => {
  try {
    const metrics = getSendMetrics();
    return res.json(metrics);
  } catch (err) {
    console.error('[METRICS][SEND][ERR]', { error: err.message });
    return res.status(500).json({ ok: false, error: 'METRICS_FAILED' });
  }
});

// Endpoint: Obter métricas de latência (webhook_ack_ms, telegram_http_ms, etc)
app.get('/api/admin/metrics/latency', requireAdmin, async (req, res) => {
  try {
    const { getMetrics } = require('./lib/metricsService');
    const metrics = getMetrics();
    return res.json(metrics);
  } catch (err) {
    console.error('[METRICS][LATENCY][ERR]', { error: err.message });
    return res.status(500).json({ ok: false, error: 'METRICS_FAILED' });
  }
});

// Endpoint: Obter métricas da fila
app.get('/api/admin/metrics/queue', requireAdmin, async (req, res) => {
  try {
    const queueMetrics = getQueueMetrics();
    const heartbeatMetrics = heartbeat.getMetrics();
    
    return res.json({
      queue: queueMetrics,
      heartbeat: heartbeatMetrics
    });
  } catch (err) {
    console.error('[METRICS][QUEUE][ERR]', { error: err.message });
    return res.status(500).json({ ok: false, error: 'METRICS_FAILED' });
  }
});

// Endpoint: Obter todas as métricas (para validação de critérios de aceite)
app.get('/api/admin/metrics/all', requireAdmin, async (req, res) => {
  try {
    const { getMetrics: getLatencyMetrics } = require('./lib/metricsService');
    const latencyMetrics = getLatencyMetrics();
    const queueMetrics = getQueueMetrics();
    const heartbeatMetrics = heartbeat.getMetrics();
    const sendMetrics = getSendMetrics();
    
    return res.json({
      timestamp: new Date().toISOString(),
      webhook: latencyMetrics.webhook,
      start: latencyMetrics.start,
      send: {
        ...latencyMetrics.send,
        legacy: sendMetrics
      },
      queue: {
        ...latencyMetrics.queue,
        manager: queueMetrics
      },
      backoff_429: latencyMetrics.backoff_429,
      heartbeat: {
        ...latencyMetrics.heartbeat,
        manager: heartbeatMetrics
      }
    });
  } catch (err) {
    console.error('[METRICS][ALL][ERR]', { error: err.message });
    return res.status(500).json({ ok: false, error: 'METRICS_FAILED' });
  }
});

// Endpoint: Definir webhook no Telegram
app.post('/api/admin/bots/:slug/webhook/set', requireAdmin, async (req, res) => {
  const request_id = genReqId();
  const slug = (req.params.slug || '').trim();

  if (!slug) {
    console.warn('[WEBHOOK][SET][INVALID]', { request_id, error: 'MISSING_SLUG' });
    return res.status(400).json({ ok: false, error: 'MISSING_SLUG' });
  }

  const pool = await getPgPool();
  if (!pool) {
    console.error('[WEBHOOK][SET][ERR]', { request_id, slug, error: 'DATABASE_NOT_AVAILABLE' });
    return res.status(503).json({ ok: false, error: 'DATABASE_NOT_AVAILABLE' });
  }

  try {
    // Buscar token do bot
    const token = await getTokenBySlug(pool, slug);
    
    if (!token) {
      console.warn('[WEBHOOK][SET][NO_TOKEN]', { request_id, slug });
      return res.status(400).json({ ok: false, error: 'BOT_TOKEN_NOT_SET' });
    }

    // Preferir a URL enviada pelo front; se não vier, construir pela requisição
    let webhookUrl = (req.body?.url || '').trim();
    if (!webhookUrl) {
      webhookUrl = `${getPublicBase(req)}/tg/${encodeURIComponent(slug)}/webhook`;
    }

    // Normalizar e validar HTTPS
    webhookUrl = webhookUrl.replace(/\/+$/, ''); // sem barra final
    if (!/^https:\/\//i.test(webhookUrl)) {
      console.warn('[WEBHOOK][SET][HTTPS_REQUIRED]', { request_id, slug, url: webhookUrl });
      return res.status(400).json({ ok: false, error: 'HTTPS_REQUIRED', message: 'An HTTPS URL must be provided for webhook' });
    }

    const secretToken = process.env.TELEGRAM_WEBHOOK_SECRET || '';

    console.info('[WEBHOOK][SET][START]', {
      request_id,
      slug,
      webhook_url: webhookUrl
    });

    // Chamar API do Telegram
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    
    const telegramUrl = `https://api.telegram.org/bot${token}/setWebhook`;
    const response = await fetch(telegramUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: webhookUrl,
        secret_token: secretToken,
        drop_pending_updates: true
      }),
      signal: controller.signal
    });
    
    clearTimeout(timeout);
    
    const data = await response.json();

    if (data.ok) {
      console.info('[WEBHOOK][SET][OK]', {
        request_id,
        slug,
        webhook_url: webhookUrl
      });

      return res.json({
        ok: true,
        webhook_url: webhookUrl,
        description: data.description || 'Webhook configured successfully'
      });
    } else {
      console.error('[WEBHOOK][SET][TELEGRAM_ERR]', {
        request_id,
        slug,
        error: data.description
      });

      return res.status(400).json({
        ok: false,
        error: 'TELEGRAM_ERROR',
        description: data.description
      });
    }
  } catch (err) {
    console.error('[WEBHOOK][SET][EXCEPTION]', {
      request_id,
      slug,
      error: err.message
    });

    return res.status(500).json({
      ok: false,
      error: 'INTERNAL_ERROR',
      description: err.message
    });
  }
});

// Endpoint: Remover webhook no Telegram
app.post('/api/admin/bots/:slug/webhook/delete', requireAdmin, async (req, res) => {
  const request_id = genReqId();
  const slug = (req.params.slug || '').trim();

  if (!slug) {
    console.warn('[WEBHOOK][DELETE][INVALID]', { request_id, error: 'MISSING_SLUG' });
    return res.status(400).json({ ok: false, error: 'MISSING_SLUG' });
  }

  const pool = await getPgPool();
  if (!pool) {
    console.error('[WEBHOOK][DELETE][ERR]', { request_id, slug, error: 'DATABASE_NOT_AVAILABLE' });
    return res.status(503).json({ ok: false, error: 'DATABASE_NOT_AVAILABLE' });
  }

  try {
    // Buscar token do bot
    const token = await getTokenBySlug(pool, slug);
    
    if (!token) {
      console.warn('[WEBHOOK][DELETE][NO_TOKEN]', { request_id, slug });
      return res.status(400).json({ ok: false, error: 'BOT_TOKEN_NOT_SET' });
    }

    console.info('[WEBHOOK][DELETE][START]', { request_id, slug });

    // Chamar API do Telegram
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    
    const telegramUrl = `https://api.telegram.org/bot${token}/deleteWebhook`;
    const response = await fetch(telegramUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        drop_pending_updates: true
      }),
      signal: controller.signal
    });
    
    clearTimeout(timeout);
    
    const data = await response.json();

    if (data.ok) {
      console.info('[WEBHOOK][DELETE][OK]', { request_id, slug });

      return res.json({
        ok: true,
        description: data.description || 'Webhook removed successfully'
      });
    } else {
      console.error('[WEBHOOK][DELETE][TELEGRAM_ERR]', {
        request_id,
        slug,
        error: data.description
      });

      return res.status(400).json({
        ok: false,
        error: 'TELEGRAM_ERROR',
        description: data.description
      });
    }
  } catch (err) {
    console.error('[WEBHOOK][DELETE][EXCEPTION]', {
      request_id,
      slug,
      error: err.message
    });

    return res.status(500).json({
      ok: false,
      error: 'INTERNAL_ERROR',
      description: err.message
    });
  }
});

// Endpoint: Ver status do webhook no Telegram
app.get('/api/admin/bots/:slug/webhook/status', requireAdmin, async (req, res) => {
  const request_id = genReqId();
  const slug = (req.params.slug || '').trim();

  if (!slug) {
    console.warn('[WEBHOOK][STATUS][INVALID]', { request_id, error: 'MISSING_SLUG' });
    return res.status(400).json({ ok: false, error: 'MISSING_SLUG' });
  }

  const pool = await getPgPool();
  if (!pool) {
    console.error('[WEBHOOK][STATUS][ERR]', { request_id, slug, error: 'DATABASE_NOT_AVAILABLE' });
    return res.status(503).json({ ok: false, error: 'DATABASE_NOT_AVAILABLE' });
  }

  try {
    // Buscar token do bot
    const token = await getTokenBySlug(pool, slug);
    
    if (!token) {
      console.warn('[WEBHOOK][STATUS][NO_TOKEN]', { request_id, slug });
      return res.status(400).json({ ok: false, error: 'BOT_TOKEN_NOT_SET' });
    }

    console.info('[WEBHOOK][STATUS][START]', { request_id, slug });

    // Chamar API do Telegram
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    
    const telegramUrl = `https://api.telegram.org/bot${token}/getWebhookInfo`;
    const response = await fetch(telegramUrl, {
      method: 'GET',
      signal: controller.signal
    });
    
    clearTimeout(timeout);
    
    const data = await response.json();

    if (data.ok) {
      const info = data.result || {};
      
      console.info('[WEBHOOK][STATUS][OK]', {
        request_id,
        slug,
        has_webhook: !!info.url,
        pending_count: info.pending_update_count || 0
      });

      return res.json({
        ok: true,
        url: info.url || null,
        has_custom_certificate: info.has_custom_certificate || false,
        pending_update_count: info.pending_update_count || 0,
        last_error_date: info.last_error_date || null,
        last_error_message: info.last_error_message || null,
        max_connections: info.max_connections || null,
        ip_address: info.ip_address || null
      });
    } else {
      console.error('[WEBHOOK][STATUS][TELEGRAM_ERR]', {
        request_id,
        slug,
        error: data.description
      });

      return res.status(400).json({
        ok: false,
        error: 'TELEGRAM_ERROR',
        description: data.description
      });
    }
  } catch (err) {
    console.error('[WEBHOOK][STATUS][EXCEPTION]', {
      request_id,
      slug,
      error: err.message
    });

    return res.status(500).json({
      ok: false,
      error: 'INTERNAL_ERROR',
      description: err.message
    });
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

// ========== WEBHOOKS DE PAGAMENTO (PIX) ==========
// NOTA: Integre estes endpoints com seu gateway de pagamento
// Eles gerenciam agendamento de downsells e cancelamento ao pagar
const paymentWebhookService = require('./lib/paymentWebhookService');

// Webhook: PIX criado (agenda downsells com gatilho PIX)
app.post('/api/payment/webhook/pix-created', async (req, res) => {
  const started = Date.now();
  const request_id = genReqId();
  
  // ACK IMEDIATO (antes de qualquer I/O)
  res.status(200).json({ ok: true });
  
  // Processar em background
  setImmediate(async () => {
    try {
      const pool = await getPgPool();
      await paymentWebhookService.handlePixCreated(pool, {
        bot_slug: req.body.bot_slug,
        telegram_id: req.body.telegram_id,
        transaction_id: req.body.transaction_id,
        correlation_id: req.body.correlation_id || request_id
      });
      
      const done_ms = Date.now() - started;
      observe('payment_webhook_pix_created_ms', done_ms, { bot: req.body.bot_slug });
    } catch (err) {
      console.error('[PAYMENT_WEBHOOK][PIX_CREATED][BG_ERR]', { request_id, error: err.message });
    }
  });
});

// Webhook: Pagamento aprovado (cancela downsells pendentes)
app.post('/api/payment/webhook/payment-approved', async (req, res) => {
  const started = Date.now();
  const request_id = genReqId();
  
  // ACK IMEDIATO (antes de qualquer I/O)
  res.status(200).json({ ok: true });
  
  // Processar em background
  setImmediate(async () => {
    try {
      const pool = await getPgPool();
      await paymentWebhookService.handlePaymentApproved(pool, {
        bot_slug: req.body.bot_slug,
        telegram_id: req.body.telegram_id,
        transaction_id: req.body.transaction_id
      });
      
      const done_ms = Date.now() - started;
      observe('payment_webhook_approved_ms', done_ms, { bot: req.body.bot_slug });
    } catch (err) {
      console.error('[PAYMENT_WEBHOOK][PAYMENT_APPROVED][BG_ERR]', { request_id, error: err.message });
    }
  });
});

// Webhook: PIX expirado (cancela downsells da transação)
app.post('/api/payment/webhook/pix-expired', async (req, res) => {
  const started = Date.now();
  const request_id = genReqId();
  
  // ACK IMEDIATO (antes de qualquer I/O)
  res.status(200).json({ ok: true });
  
  // Processar em background
  setImmediate(async () => {
    try {
      const pool = await getPgPool();
      await paymentWebhookService.handlePixExpired(pool, {
        transaction_id: req.body.transaction_id
      });
      
      const done_ms = Date.now() - started;
      observe('payment_webhook_expired_ms', done_ms);
    } catch (err) {
      console.error('[PAYMENT_WEBHOOK][PIX_EXPIRED][BG_ERR]', { request_id, error: err.message });
    }
  });
});
// ========== FIM WEBHOOKS DE PAGAMENTO ==========

// ========== MEDIA MANAGEMENT API ==========

const { saveMedia, listMedia, getMediaById } = require('./lib/mediaService');
const { isR2Configured } = require('./lib/r2Service');
const { enqueuePrewarm: enqueueMediaPrewarm, getQueueMetrics: getMediaQueueMetrics } = require('./lib/mediaPrewarmWorker');

// Endpoint: Upload de mídia (POST /api/admin/bots/:slug/media)
app.post('/api/admin/bots/:slug/media', strictRateLimit, requireAdmin, async (req, res) => {
  const request_id = genReqId();
  const slug = (req.params.slug || '').trim();
  
  if (!slug) {
    console.warn('[ADMIN_MEDIA][UPLOAD][INVALID]', { request_id, error: 'MISSING_SLUG' });
    return res.status(400).json({ ok: false, error: 'MISSING_SLUG' });
  }
  
  // Verificar se R2 está configurado
  if (!isR2Configured()) {
    console.warn('[ADMIN_MEDIA][UPLOAD][R2_NOT_CONFIGURED]', { request_id, slug });
    return res.status(503).json({
      ok: false,
      error: 'R2_NOT_CONFIGURED',
      message: 'R2 storage is not configured. Please set R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY.'
    });
  }
  
  const pool = await getPgPool();
  if (!pool) {
    return res.status(503).json({ ok: false, error: 'DATABASE_NOT_AVAILABLE' });
  }
  
  try {
    // Espera receber base64 ou multipart (aqui implementamos base64 para simplicidade)
    const { kind, data_base64, mime, ext, width, height, duration } = req.body;
    
    if (!kind || !data_base64) {
      return res.status(400).json({
        ok: false,
        error: 'MISSING_REQUIRED_FIELDS',
        message: 'kind and data_base64 are required'
      });
    }
    
    if (!['photo', 'video', 'document', 'audio'].includes(kind)) {
      return res.status(400).json({
        ok: false,
        error: 'INVALID_KIND',
        message: 'kind must be one of: photo, video, document, audio'
      });
    }
    
    // Decodificar base64
    const buffer = Buffer.from(data_base64, 'base64');
    
    // Salvar no R2 e registrar no media_store
    const result = await saveMedia(pool, buffer, slug, kind, {
      mime,
      ext,
      width,
      height,
      duration
    });
    
    // Enfileirar para aquecimento
    enqueueMediaPrewarm({
      bot_slug: slug,
      sha256: result.sha256,
      kind,
      r2_key: result.r2_key
    });
    
    console.info('[ADMIN_MEDIA][UPLOAD][OK]', {
      request_id,
      slug,
      kind,
      media_id: result.media_id,
      sha256: result.sha256,
      bytes: result.bytes
    });
    
    return res.status(201).json({
      ok: true,
      media_id: result.media_id,
      r2_key: result.r2_key,
      sha256: result.sha256,
      bytes: result.bytes,
      warming: true
    });
    
  } catch (err) {
    console.error('[ADMIN_MEDIA][UPLOAD][ERR]', {
      request_id,
      slug,
      error: err.message
    });
    
    return res.status(500).json({
      ok: false,
      error: 'UPLOAD_FAILED',
      message: err.message
    });
  }
});

// Endpoint: Listar mídias de um bot (GET /api/admin/bots/:slug/media)
app.get('/api/admin/bots/:slug/media', rateLimit, requireAdmin, async (req, res) => {
  const request_id = genReqId();
  const slug = (req.params.slug || '').trim();
  const kind = req.query.kind;
  const limit = parseInt(req.query.limit) || 50;
  const offset = parseInt(req.query.offset) || 0;
  
  if (!slug) {
    console.warn('[ADMIN_MEDIA][LIST][INVALID]', { request_id, error: 'MISSING_SLUG' });
    return res.status(400).json({ ok: false, error: 'MISSING_SLUG' });
  }
  
  const pool = await getPgPool();
  if (!pool) {
    return res.status(503).json({ ok: false, error: 'DATABASE_NOT_AVAILABLE' });
  }
  
  try {
    const media = await listMedia(pool, slug, { kind, limit, offset });
    
    console.info('[ADMIN_MEDIA][LIST][OK]', {
      request_id,
      slug,
      kind,
      count: media.length
    });
    
    return res.json({
      ok: true,
      media,
      count: media.length,
      limit,
      offset
    });
    
  } catch (err) {
    console.error('[ADMIN_MEDIA][LIST][ERR]', {
      request_id,
      slug,
      error: err.message
    });
    
    return res.status(500).json({
      ok: false,
      error: 'LIST_FAILED',
      message: err.message
    });
  }
});

// Endpoint: Obter detalhes de uma mídia (GET /api/admin/media/:id)
app.get('/api/admin/media/:id', rateLimit, requireAdmin, async (req, res) => {
  const request_id = genReqId();
  const mediaId = parseInt(req.params.id);
  
  if (!mediaId || isNaN(mediaId)) {
    console.warn('[ADMIN_MEDIA][GET][INVALID]', { request_id, error: 'INVALID_ID' });
    return res.status(400).json({ ok: false, error: 'INVALID_ID' });
  }
  
  const pool = await getPgPool();
  if (!pool) {
    return res.status(503).json({ ok: false, error: 'DATABASE_NOT_AVAILABLE' });
  }
  
  try {
    const media = await getMediaById(pool, mediaId);
    
    if (!media) {
      console.warn('[ADMIN_MEDIA][GET][NOT_FOUND]', { request_id, mediaId });
      return res.status(404).json({ ok: false, error: 'MEDIA_NOT_FOUND' });
    }
    
    console.info('[ADMIN_MEDIA][GET][OK]', {
      request_id,
      mediaId,
      bot_slug: media.bot_slug,
      kind: media.kind
    });
    
    return res.json({
      ok: true,
      media
    });
    
  } catch (err) {
    console.error('[ADMIN_MEDIA][GET][ERR]', {
      request_id,
      mediaId,
      error: err.message
    });
    
    return res.status(500).json({
      ok: false,
      error: 'GET_FAILED',
      message: err.message
    });
  }
});

// Endpoint: Reaquecer mídia (POST /api/admin/media/:id/rewarm)
app.post('/api/admin/media/:id/rewarm', strictRateLimit, requireAdmin, async (req, res) => {
  const request_id = genReqId();
  const mediaId = parseInt(req.params.id);
  
  if (!mediaId || isNaN(mediaId)) {
    console.warn('[ADMIN_MEDIA][REWARM][INVALID]', { request_id, error: 'INVALID_ID' });
    return res.status(400).json({ ok: false, error: 'INVALID_ID' });
  }
  
  const pool = await getPgPool();
  if (!pool) {
    return res.status(503).json({ ok: false, error: 'DATABASE_NOT_AVAILABLE' });
  }
  
  try {
    const media = await getMediaById(pool, mediaId);
    
    if (!media) {
      console.warn('[ADMIN_MEDIA][REWARM][NOT_FOUND]', { request_id, mediaId });
      return res.status(404).json({ ok: false, error: 'MEDIA_NOT_FOUND' });
    }
    
    // Enfileirar para aquecimento
    const enqueued = enqueueMediaPrewarm({
      bot_slug: media.bot_slug,
      sha256: media.sha256,
      kind: media.kind,
      r2_key: media.r2_key
    });
    
    if (!enqueued) {
      return res.status(429).json({
        ok: false,
        error: 'QUEUE_FULL_OR_DUPLICATE',
        message: 'Media is already being warmed or queue is full'
      });
    }
    
    console.info('[ADMIN_MEDIA][REWARM][OK]', {
      request_id,
      mediaId,
      bot_slug: media.bot_slug,
      sha256: media.sha256
    });
    
    return res.json({
      ok: true,
      message: 'Media queued for warming',
      media_id: mediaId
    });
    
  } catch (err) {
    console.error('[ADMIN_MEDIA][REWARM][ERR]', {
      request_id,
      mediaId,
      error: err.message
    });
    
    return res.status(500).json({
      ok: false,
      error: 'REWARM_FAILED',
      message: err.message
    });
  }
});

// Endpoint: Atualizar warmup_chat_id de um bot (PUT /api/admin/bots/:slug/warmup-chat)
app.put('/api/admin/bots/:slug/warmup-chat', strictRateLimit, requireAdmin, async (req, res) => {
  const request_id = genReqId();
  const slug = (req.params.slug || '').trim();
  const warmup_chat_id = req.body.warmup_chat_id;
  
  if (!slug) {
    console.warn('[ADMIN_BOT][WARMUP_CHAT][INVALID]', { request_id, error: 'MISSING_SLUG' });
    return res.status(400).json({ ok: false, error: 'MISSING_SLUG' });
  }
  
  if (!warmup_chat_id) {
    console.warn('[ADMIN_BOT][WARMUP_CHAT][INVALID]', { request_id, slug, error: 'MISSING_WARMUP_CHAT_ID' });
    return res.status(400).json({ ok: false, error: 'MISSING_WARMUP_CHAT_ID' });
  }
  
  const pool = await getPgPool();
  if (!pool) {
    return res.status(503).json({ ok: false, error: 'DATABASE_NOT_AVAILABLE' });
  }
  
  try {
    const query = `
      UPDATE bots
      SET warmup_chat_id = $1
      WHERE slug = $2 AND deleted_at IS NULL
      RETURNING slug, warmup_chat_id
    `;
    
    const result = await pool.query(query, [warmup_chat_id, slug]);
    
    if (result.rowCount === 0) {
      console.warn('[ADMIN_BOT][WARMUP_CHAT][NOT_FOUND]', { request_id, slug });
      return res.status(404).json({ ok: false, error: 'BOT_NOT_FOUND' });
    }
    
    console.info('[ADMIN_BOT][WARMUP_CHAT][OK]', {
      request_id,
      slug,
      warmup_chat_id
    });
    
    return res.json({
      ok: true,
      slug,
      warmup_chat_id
    });
    
  } catch (err) {
    console.error('[ADMIN_BOT][WARMUP_CHAT][ERR]', {
      request_id,
      slug,
      error: err.message
    });
    
    return res.status(500).json({
      ok: false,
      error: 'UPDATE_FAILED',
      message: err.message
    });
  }
});

// Endpoint: Preview de mídia (GET /api/media/preview/:id)
// Rota pública sem autenticação para permitir <img src> no admin
app.get('/api/media/preview/:id', async (req, res) => {
  const mediaId = parseInt(req.params.id);
  
  if (!mediaId || isNaN(mediaId)) {
    return res.status(400).send('Invalid media ID');
  }
  
  const pool = await getPgPool();
  if (!pool) {
    return res.status(503).send('Database not available');
  }
  
  try {
    const media = await getMediaById(pool, mediaId);
    
    if (!media) {
      return res.status(404).send('Media not found');
    }
    
    // Download do R2
    const { downloadMedia } = require('./lib/r2Service');
    const buffer = await downloadMedia(media.r2_key);
    
    // Set appropriate content type
    const contentType = media.mime || 'application/octet-stream';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache por 1 dia
    res.setHeader('Content-Length', buffer.length);
    
    return res.send(buffer);
    
  } catch (err) {
    console.error('[MEDIA][PREVIEW][ERR]', {
      mediaId,
      error: err.message
    });
    
    return res.status(500).send('Failed to load media');
  }
});

// Endpoint: Obter métricas da fila de aquecimento (GET /api/admin/media/queue/metrics)
app.get('/api/admin/media/queue/metrics', rateLimit, requireAdmin, async (req, res) => {
  const request_id = genReqId();
  
  try {
    const metrics = getMediaQueueMetrics();
    
    console.info('[ADMIN_MEDIA][QUEUE_METRICS][OK]', {
      request_id,
      ...metrics
    });
    
    return res.json({
      ok: true,
      ...metrics
    });
    
  } catch (err) {
    console.error('[ADMIN_MEDIA][QUEUE_METRICS][ERR]', {
      request_id,
      error: err.message
    });
    
    return res.status(500).json({
      ok: false,
      error: 'METRICS_FAILED',
      message: err.message
    });
  }
});

// ========== FIM MEDIA MANAGEMENT API ==========

app.use(express.static(publicDirectory, {
  extensions: ['html'],
  fallthrough: true
}));

// Servir documentação OpenAPI
const fs = require('fs');
app.get('/docs/openapi.yaml', (req, res) => {
  const yamlPath = path.join(__dirname, 'docs', 'openapi.yaml');
  if (fs.existsSync(yamlPath)) {
    res.type('text/yaml').sendFile(yamlPath);
  } else {
    res.status(404).send('Documentation not found');
  }
});

app.get('/env.js', (req, res) => {
  const base = process.env.APP_BASE_URL || `${forwardedProto(req)}://${forwardedHost(req)}`;
  const pub = process.env.PUBLIC_BASE_URL || `${forwardedProto(req)}://${forwardedHost(req)}`;
  const adminToken = process.env.ADMIN_API_TOKEN || '';

  res.set('Content-Type', 'application/javascript');
  res.set('Cache-Control', 'no-store');
  res.send(`window.__ENV__ = { APP_BASE_URL: '${base}', PUBLIC_BASE_URL: '${pub}', ADMIN_API_TOKEN: '${adminToken}' };`);
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

// ---- Health checks ----

// Health check simples (para load balancers e monitores externos)
app.get('/healthz', (_req, res) => {
  res.status(200).type('text/plain').send('ok');
});
app.head('/healthz', (_req, res) => res.sendStatus(200));

// Health check detalhado (retorna métricas e status dos serviços)
app.get('/health', async (req, res) => {
  const startTime = Date.now();
  const health = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    version: require('./package.json').version,
    environment: process.env.NODE_ENV || 'development',
    checks: {}
  };
  
  // Check: Database
  try {
    const pool = await getPgPool();
    if (pool) {
      const dbStart = Date.now();
      await pool.query('SELECT 1');
      const dbLatency = Date.now() - dbStart;
      health.checks.database = {
        status: 'ok',
        latency_ms: dbLatency
      };
    } else {
      health.checks.database = {
        status: 'unavailable',
        message: 'Using in-memory storage'
      };
    }
  } catch (err) {
    health.status = 'degraded';
    health.checks.database = {
      status: 'error',
      message: err.message
    };
  }
  
  // Check: Memory usage
  const memUsage = process.memoryUsage();
  health.checks.memory = {
    status: 'ok',
    rss_mb: Math.round(memUsage.rss / 1024 / 1024),
    heap_used_mb: Math.round(memUsage.heapUsed / 1024 / 1024),
    heap_total_mb: Math.round(memUsage.heapTotal / 1024 / 1024),
    external_mb: Math.round(memUsage.external / 1024 / 1024)
  };
  
  // Check: Rate limiters (memory leak prevention)
  try {
    const { getStats } = require('./lib/rateLimiterCleanup');
    const sendService = require('./lib/sendService');
    // Note: rateLimiters é privado, então não podemos acessá-lo diretamente
    // Incluir se for exportado futuramente
    health.checks.rate_limiters = {
      status: 'ok',
      message: 'Cleanup active'
    };
  } catch (err) {
    // Ignorar se módulo não estiver disponível
  }
  
  // Check: Queue status
  try {
    const queueMetrics = getQueueMetrics();
    health.checks.queue = {
      status: 'ok',
      ...queueMetrics
    };
  } catch (err) {
    // Ignorar se não disponível
  }
  
  // Tempo total de health check
  health.response_time_ms = Date.now() - startTime;
  
  // Determinar status HTTP baseado na saúde
  const statusCode = health.status === 'ok' ? 200 : 503;
  
  res.status(statusCode).json(health);
});

app.use((req, res) => {
  res.status(404).send('Not Found');
});

// Iniciar sistema de alerting/monitoramento
const { startMonitoring } = require('./lib/alerting');
startMonitoring(getPgPool(), 5); // Check a cada 5 minutos

const HOST = '0.0.0.0';
app.listen(PORT, HOST, async () => {
  console.log(`Servidor ouvindo na porta ${PORT}`);
  
  // Iniciar queue manager
  queueManager.start();
  
  // Garantir partição do mês atual (não bloqueia a escuta)
  try {
    const { spawn } = require('child_process');
    spawn(process.execPath, ['scripts/migrate-fe-partition.js'], { stdio: 'inherit' });
  } catch (e) {
    console.warn('[PARTITION][WARN]', e?.message || e);
  }
  
  // Iniciar heartbeats e warm-up para todos os bots
  try {
    const pool = await getPgPool();
    if (pool) {
      // Iniciar heartbeat PG
      heartbeat.startPgHeartbeat(pool);
      
      // Iniciar workers de downsell e disparo
      downsellWorker.start(pool, 10000); // 10s
      // downsellScheduler.start(pool, queueManager, 3000); // DESABILITADO: risco de duplicação com worker
      shotWorker.start(pool, 5000); // 5s
      
      // Iniciar worker de aquecimento de mídia
      const { startPrewarmWorker } = require('./lib/mediaPrewarmWorker');
      startPrewarmWorker(pool, 2000); // 2s (processa fila a cada 2s)
      
      console.info('[BOOT] Workers iniciados: downsellWorker, shotWorker, mediaPrewarmWorker');
      
      const { rows } = await pool.query(`
        SELECT slug, token_encrypted, token_iv 
        FROM public.bots 
        WHERE deleted_at IS NULL 
          AND token_encrypted IS NOT NULL 
          AND token_iv IS NOT NULL
      `);
      
      console.info('[BOOT] Inicializando bots:', { bot_count: rows.length });
      
      for (const row of rows) {
        try {
          const token = await getTokenBySlug(pool, row.slug);
          if (token) {
            // Warm-up inicial
            warmUpTelegram(token).catch(err => {
              console.warn('[WARMUP][BOOT][ERR]', { slug: row.slug, error: err.message });
            });
            
            // Iniciar heartbeat HTTP para este bot
            heartbeat.startHttpHeartbeat(row.slug, token);
          }
        } catch (err) {
          console.warn('[BOOT][TOKEN_ERR]', { slug: row.slug, error: err.message });
        }
      }
    }
  } catch (err) {
    console.warn('[BOOT][FAILED]', { error: err.message });
  }
});
