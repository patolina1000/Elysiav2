const express = require('express');
const path = require('path');

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

// Lista bots (sem auth por enquanto)
app.get('/api/admin/bots', (req, res) => {
  const request_id = genReqId();
  const list = Array.from(mem.bots.values()).map(b => ({
    name: b.name,
    slug: b.slug,
    provider: b.provider,
    use_album: b.use_album,
    // nunca devolva token; só indique se existe
    has_token: !!b.token,
    // ecoa os imutáveis para a UI ver
    rate_per_minute: b.rate_per_minute,
    sandbox: b.sandbox,
    renderer: b.renderer,
    typing_delay_ms: b.typing_delay_ms,
    watermark: b.watermark,
    webhook_url: b.webhook_url,
    created_at: b.created_at,
  }));
  console.info('[ADMIN_BOTS][LIST]', { request_id, count: list.length });
  res.json(list);
});

// Cria bot (sem auth por enquanto) + defaults imutáveis
app.post('/api/admin/bots', express.json(), (req, res) => {
  const request_id = genReqId();
  const { errors, name, slug, provider, use_album, token } = validateBotPayload(req.body || {});
  if (errors.length) {
    console.warn('[ADMIN_BOTS][CREATE][INVALID]', { request_id, errors });
    return res.status(400).json({ ok: false, error: 'INVALID_PAYLOAD', details: errors });
  }
  if (mem.bots.has(slug)) {
    console.warn('[ADMIN_BOTS][CREATE][CONFLICT]', { request_id, slug });
    return res.status(409).json({ ok: false, error: 'SLUG_ALREADY_EXISTS' });
  }

  const publicBase = getPublicBaseUrl(req);
  const webhook_url = `${publicBase}/tg/${encodeURIComponent(slug)}/webhook`;

  const bot = {
    // recebidos
    name, slug, provider, use_album: !!use_album,
    // opcionais
    token: token || null,
    // imutáveis (FORÇADOS)
    rate_per_minute: IMMUTABLE_DEFAULTS.rate_per_minute,
    sandbox:          IMMUTABLE_DEFAULTS.sandbox,
    renderer:         IMMUTABLE_DEFAULTS.renderer,
    typing_delay_ms:  IMMUTABLE_DEFAULTS.typing_delay_ms,
    watermark:        IMMUTABLE_DEFAULTS.watermark,
    // derivados
    webhook_url,
    created_at: new Date().toISOString(),
  };

  mem.bots.set(slug, bot);

  console.info('[ADMIN_BOTS][CREATE][OK]', {
    request_id, slug, provider,
    use_album: bot.use_album,
    has_token: !!bot.token,
    token_masked: maskToken(bot.token),
    forced_defaults: {
      rate_per_minute: bot.rate_per_minute,
      sandbox: bot.sandbox,
      renderer: bot.renderer,
      typing_delay_ms: bot.typing_delay_ms,
      watermark: bot.watermark,
    },
    webhook_url: bot.webhook_url,
  });

  // nunca retornar token
  const { token: _omit, ...safe } = bot;
  res.status(201).json({
    ok: true,
    slug: bot.slug,
    webhook_url: bot.webhook_url,
    bot: { ...safe, has_token: !!bot.token }
  });
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
