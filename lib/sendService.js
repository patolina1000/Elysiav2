const { getTokenBySlug, maskToken } = require('./tokenService');
const crypto = require('crypto');
const telegramClient = require('./telegramClient');
const { observe } = require('./metricsService');
const config = require('../config/rate');

/**
 * Serviço único de envio de mensagens via Telegram
 * Usado por: send-test, /start, downsell, disparo
 * Otimizado com keep-alive e métricas detalhadas
 */

// Feature flag: desabilitar gateway_events por padrão em dev (evita I/O no hot-path)
const DISABLE_GATEWAY_EVENTS = process.env.DISABLE_GATEWAY_EVENTS === '1' 
  || config.GATEWAY_EVENTS_DISABLED_BY_DEFAULT;

// Rate limiters em memória (token bucket)
const rateLimiters = {
  byBot: new Map(), // slug -> { tokens, lastRefill }
  byChat: new Map(), // chat_id -> lastSent timestamp
};

// Fila leve em memória
const sendQueue = [];
const MAX_QUEUE_SIZE = 100;

// Métricas
const metrics = {
  send: {
    ok: new Map(), // key: slug:purpose -> count
    err: new Map(),
    latency: new Map(), // key: slug:purpose -> [latencies]
  }
};

/**
 * Escapa caracteres especiais para MarkdownV2
 */
function escapeMarkdownV2(text) {
  if (!text) return '';
  // Caracteres que precisam ser escapados no MarkdownV2
  const specialChars = ['_', '*', '[', ']', '(', ')', '~', '`', '>', '#', '+', '-', '=', '|', '{', '}', '.', '!'];
  let escaped = String(text);
  
  for (const char of specialChars) {
    escaped = escaped.split(char).join('\\' + char);
  }
  
  return escaped;
}

/**
 * Gera chave de deduplicação baseada no purpose
 */
function generateDedupeKey(purpose, params) {
  const { slug, chat_id, text, start_session_id, queue_id, shot_id } = params;
  
  switch (purpose) {
    case 'send-test': {
      const now = new Date();
      const minute = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}`;
      const textHash = crypto.createHash('md5').update(text || '').digest('hex').slice(0, 8);
      return `test:${slug}:${chat_id}:${textHash}:${minute}`;
    }
    case 'start':
      return `start:${slug}:${chat_id}:${start_session_id || 'default'}`;
    case 'downsell':
      return `downsell:${queue_id}`;
    case 'shot':
      return `shot:${shot_id}:${chat_id}`;
    default:
      return `unknown:${slug}:${chat_id}:${Date.now()}`;
  }
}

/**
 * Verifica rate limit por bot (60 msg/min)
 */
function checkBotRateLimit(slug) {
  const now = Date.now();
  const limit = rateLimiters.byBot.get(slug);
  
  if (!limit) {
    rateLimiters.byBot.set(slug, { tokens: 59, lastRefill: now });
    return true;
  }
  
  // Refill tokens (1 token por segundo = 60/min)
  const elapsed = (now - limit.lastRefill) / 1000;
  const tokensToAdd = Math.floor(elapsed);
  
  if (tokensToAdd > 0) {
    limit.tokens = Math.min(60, limit.tokens + tokensToAdd);
    limit.lastRefill = now;
  }
  
  if (limit.tokens > 0) {
    limit.tokens--;
    return true;
  }
  
  return false;
}

/**
 * Verifica rate limit por chat (1 msg/s)
 */
function checkChatRateLimit(chat_id) {
  const now = Date.now();
  const lastSent = rateLimiters.byChat.get(String(chat_id));
  
  if (!lastSent || (now - lastSent) >= 1000) {
    rateLimiters.byChat.set(String(chat_id), now);
    return true;
  }
  
  return false;
}

/**
 * Registra evento no banco de dados (não bloqueia o fluxo)
 */
async function recordGatewayEvent(pool, params) {
  // Feature flag para dev
  if (DISABLE_GATEWAY_EVENTS) {
    console.info('[GATEWAY_EVENT][DISABLED]', { slug: params.slug, purpose: params.purpose });
    return true;
  }
  
  const {
    request_id,
    slug,
    chat_id,
    message_id,
    status,
    lat_ms,
    purpose,
    dedupe_key,
    error_code
  } = params;
  
  if (!pool) return false;
  
  try {
    const query = `
      INSERT INTO gateway_events (
        request_id, slug, chat_id, message_id, status, latency_ms, purpose, dedupe_key, error_code, occurred_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
      ON CONFLICT (dedupe_key) DO NOTHING
      RETURNING id
    `;
    
    const result = await pool.query(query, [
      request_id,
      slug,
      String(chat_id),
      message_id,
      status,
      lat_ms,
      purpose,
      dedupe_key,
      error_code
    ]);
    
    return result.rowCount > 0;
  } catch (err) {
    // Não bloquear o fluxo por erro de log
    console.error('[GATEWAY_EVENT][RECORD][ERR]', { error: err.message, slug, purpose });
    return false;
  }
}

/**
 * Verifica se já existe evento com a mesma dedupe_key
 */
async function checkDedupe(pool, dedupe_key) {
  if (!pool) return false;
  
  try {
    const query = `
      SELECT id, status, message_id
      FROM gateway_events
      WHERE dedupe_key = $1 AND status = 'ok'
      LIMIT 1
    `;
    
    const result = await pool.query(query, [dedupe_key]);
    return result.rowCount > 0 ? result.rows[0] : null;
  } catch (err) {
    console.error('[GATEWAY_EVENT][DEDUPE][ERR]', { error: err.message });
    return null;
  }
}

/**
 * Registra métrica
 */
function recordMetric(slug, purpose, type, value) {
  const key = `${slug}:${purpose}`;
  
  if (type === 'ok' || type === 'err') {
    const map = metrics.send[type];
    map.set(key, (map.get(key) || 0) + 1);
  } else if (type === 'latency') {
    const map = metrics.send.latency;
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(value);
    
    // Manter apenas últimas 1000 latências
    if (map.get(key).length > 1000) {
      map.get(key).shift();
    }
  }
}

/**
 * Mapeia erros do Telegram para códigos legíveis
 */
function mapTelegramError(error, statusCode = null) {
  const description = error?.description || error?.message || String(error);
  
  // 429 é tratado especialmente para backoff inteligente
  if (statusCode === 429 || description.includes('Too Many Requests')) {
    return 'RATE_LIMIT_EXCEEDED';
  }
  
  if (description.includes('chat not found')) return 'CHAT_NOT_FOUND';
  if (description.includes('bot was blocked')) return 'BOT_BLOCKED_BY_USER';
  if (description.includes('user is deactivated')) return 'USER_DEACTIVATED';
  if (description.includes('PEER_ID_INVALID')) return 'INVALID_CHAT_ID';
  if (description.includes('Forbidden')) return 'FORBIDDEN';
  if (description.includes('Bad Request')) return 'BAD_REQUEST';
  
  return 'TELEGRAM_ERROR';
}

/**
 * Envia mensagem via Telegram com keep-alive e métricas
 */
async function sendToTelegram(token, chat_id, text, options = {}) {
  const {
    parse_mode = 'MarkdownV2',
    disable_web_page_preview = true,
    retries = 3
  } = options;
  
  const result = await telegramClient.sendMessage(token, chat_id, text, {
    parse_mode,
    disable_web_page_preview,
    retries
  });
  
  // Mapear erro se necessário (incluindo 429)
  if (!result.ok) {
    result.error = mapTelegramError(
      { description: result.description }, 
      result.status_code
    );
    
    // Preservar retry_after para backoff inteligente
    if (result.retry_after) {
      result.retry_after_seconds = result.retry_after;
    }
  }
  
  return result;
}

/**
 * Serviço principal de envio
 * @param {object} pool - Pool do PostgreSQL
 * @param {object} params - Parâmetros do envio
 * @returns {Promise<object>} Resultado do envio
 */
async function sendMessage(pool, params) {
  const startTime = Date.now();
  const {
    slug,
    chat_id,
    text,
    parse_mode = 'MarkdownV2',
    disable_web_page_preview = true,
    purpose = 'send-test',
    raw = false,
    request_id = crypto.randomUUID(),
    // Params extras para dedupe
    start_session_id,
    queue_id,
    shot_id
  } = params;
  
  // Validações
  if (!slug) {
    return { ok: false, error: 'MISSING_SLUG', lat_ms: Date.now() - startTime };
  }
  
  if (!chat_id) {
    return { ok: false, error: 'MISSING_CHAT_ID', lat_ms: Date.now() - startTime };
  }
  
  if (!text) {
    return { ok: false, error: 'MISSING_TEXT', lat_ms: Date.now() - startTime };
  }
  
  try {
    // 1. Buscar token
    const token = await getTokenBySlug(pool, slug);
    
    if (!token) {
      console.warn('[SEND][NO_TOKEN]', { slug, purpose });
      recordMetric(slug, purpose, 'err', 1);
      return { ok: false, error: 'BOT_TOKEN_NOT_SET', lat_ms: Date.now() - startTime };
    }
    
    // DEDUPE DESATIVADO (caminho crítico limpo)
    // Gerar dedupe_key apenas se gateway_events estiver ativo
    const dedupe_key = (process.env.DISABLE_GATEWAY_EVENTS === '1') 
      ? null 
      : generateDedupeKey(purpose, { slug, chat_id, text, start_session_id, queue_id, shot_id });
    
    // 4. Rate limit por bot
    if (!checkBotRateLimit(slug)) {
      // Tentar enfileirar
      if (sendQueue.length < MAX_QUEUE_SIZE) {
        sendQueue.push({ pool, params, startTime });
        console.warn('[SEND][RATE_LIMIT][QUEUED]', {
          slug,
          purpose,
          queue_size: sendQueue.length
        });
        return { ok: false, error: 'RATE_LIMIT_QUEUED', lat_ms: Date.now() - startTime };
      }
      
      console.warn('[SEND][RATE_LIMIT][REJECTED]', { slug, purpose });
      recordMetric(slug, purpose, 'err', 1);
      return { ok: false, error: 'RATE_LIMIT_EXCEEDED', lat_ms: Date.now() - startTime };
    }
    
    // 5. Rate limit por chat
    if (!checkChatRateLimit(chat_id)) {
      // Enfileirar
      if (sendQueue.length < MAX_QUEUE_SIZE) {
        sendQueue.push({ pool, params, startTime });
        console.warn('[SEND][CHAT_FLOOD][QUEUED]', {
          slug,
          chat_id,
          queue_size: sendQueue.length
        });
        return { ok: false, error: 'CHAT_FLOOD_QUEUED', lat_ms: Date.now() - startTime };
      }
      
      return { ok: false, error: 'CHAT_FLOOD_EXCEEDED', lat_ms: Date.now() - startTime };
    }
    
    // 6. Escapar texto (se não for raw)
    const finalText = raw ? text : escapeMarkdownV2(text);
    
    // 7. Enviar para Telegram
    const telegramStart = Date.now();
    const result = await sendToTelegram(token, chat_id, finalText, {
      parse_mode,
      disable_web_page_preview
    });
    const telegramLat = Date.now() - telegramStart;
    
    const totalLat = Date.now() - startTime;
    
    // Métricas de latência
    observe('send_attempt_ms', totalLat, { bot: slug });
    if (result.http_latency_ms) {
      observe('telegram_http_ms', result.http_latency_ms, { bot: slug });
    }
    
    // 8. Registrar evento (opcional, desativado por padrão para performance)
    if (process.env.DISABLE_GATEWAY_EVENTS !== '1') {
      Promise.resolve().then(() =>
        recordGatewayEvent(pool, {
          request_id,
          slug,
          chat_id,
          message_id: result.message_id || null,
          status: result.ok ? 'ok' : 'error',
          lat_ms: totalLat,
          purpose,
          dedupe_key,
          error_code: result.error || null
        })
      ).catch(err => console.error('[GATEWAY_EVENT][ERR]', { slug, purpose, error: String(err) }));
    }
    
    // 9. Métricas
    if (result.ok) {
      recordMetric(slug, purpose, 'ok', 1);
      recordMetric(slug, purpose, 'latency', totalLat);
      
      console.info('[SEND][OK]', {
        request_id,
        slug,
        chat_id,
        purpose,
        message_id: result.message_id,
        text_len: text.length,
        send_attempt_ms: totalLat,
        telegram_http_ms: result.http_latency_ms || telegramLat
      });
    } else {
      recordMetric(slug, purpose, 'err', 1);
      
      console.error('[SEND][ERR]', {
        request_id,
        slug,
        chat_id,
        purpose,
        error: result.error,
        description: result.description,
        send_attempt_ms: totalLat,
        telegram_http_ms: result.http_latency_ms || telegramLat
      });
    }
    
    return {
      ok: result.ok,
      message_id: result.message_id,
      username: result.username,
      error: result.error,
      lat_ms: totalLat,
      telegram_lat_ms: telegramLat
    };
    
  } catch (err) {
    const totalLat = Date.now() - startTime;
    
    console.error('[SEND][EXCEPTION]', {
      request_id,
      slug,
      chat_id,
      purpose,
      error: err.message,
      lat_ms: totalLat
    });
    
    recordMetric(slug, purpose, 'err', 1);
    
    return {
      ok: false,
      error: 'INTERNAL_ERROR',
      description: err.message,
      lat_ms: totalLat
    };
  }
}

/**
 * Processa fila de envios (chamado periodicamente)
 */
async function processQueue() {
  if (sendQueue.length === 0) return;
  
  const item = sendQueue.shift();
  if (!item) return;
  
  const { pool, params } = item;
  
  try {
    await sendMessage(pool, params);
  } catch (err) {
    console.error('[SEND][QUEUE][ERR]', { error: err.message });
  }
}

// Processar fila a cada 100ms
setInterval(processQueue, 100);

/**
 * Obtém métricas
 */
function getMetrics() {
  const result = {
    ok: {},
    err: {},
    latency: {}
  };
  
  for (const [key, value] of metrics.send.ok.entries()) {
    result.ok[key] = value;
  }
  
  for (const [key, value] of metrics.send.err.entries()) {
    result.err[key] = value;
  }
  
  for (const [key, latencies] of metrics.send.latency.entries()) {
    if (latencies.length === 0) continue;
    
    const sorted = [...latencies].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length * 0.5)];
    const p95 = sorted[Math.floor(sorted.length * 0.95)];
    const p99 = sorted[Math.floor(sorted.length * 0.99)];
    const avg = sorted.reduce((a, b) => a + b, 0) / sorted.length;
    
    result.latency[key] = { p50, p95, p99, avg, count: sorted.length };
  }
  
  return result;
}

module.exports = {
  sendMessage,
  escapeMarkdownV2,
  generateDedupeKey,
  getMetrics
};
