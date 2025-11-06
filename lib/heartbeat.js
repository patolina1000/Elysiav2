/**
 * Heartbeats para manter conexões quentes
 * - HTTP (Telegram): ping leve a cada 30s por bot com jitter
 * - PG: ping a cada 60s
 */

const config = require('../config/rate');
const { observe } = require('./metricsService');
const { warmUp } = require('./telegramClient');

// Intervalos ativos
const activeIntervals = {
  http: new Map(), // bot slug -> intervalId
  pg: null
};

// Métricas
const metrics = {
  http: {
    ok: 0,
    err: 0,
    latencies: []
  },
  pg: {
    ok: 0,
    err: 0,
    latencies: []
  }
};

/**
 * Gerar jitter aleatório (0 a max ms)
 */
function jitter(maxMs) {
  return Math.floor(Math.random() * maxMs);
}

/**
 * Heartbeat HTTP para um bot (Telegram)
 */
async function httpHeartbeat(slug, token) {
  const start = Date.now();
  
  try {
    const result = await warmUp(token);
    const latency = Date.now() - start;
    
    if (result.ok) {
      metrics.http.ok++;
      metrics.http.latencies.push(latency);
      if (metrics.http.latencies.length > 1000) {
        metrics.http.latencies.shift();
      }
      
      observe('heartbeat_http_latency_ms', latency, { bot: slug });
      observe('heartbeat_http_ok', 1, { bot: slug });
      
      console.debug('[HEARTBEAT][HTTP][OK]', { slug, latency_ms: latency });
    } else {
      metrics.http.err++;
      observe('heartbeat_http_err', 1, { bot: slug });
      console.warn('[HEARTBEAT][HTTP][ERR]', { slug, error: result.error });
    }
  } catch (err) {
    metrics.http.err++;
    observe('heartbeat_http_err', 1, { bot: slug });
    console.error('[HEARTBEAT][HTTP][EXCEPTION]', { slug, error: err.message });
  }
}

/**
 * Iniciar heartbeat HTTP para um bot
 */
function startHttpHeartbeat(slug, token) {
  // Parar se já existe
  stopHttpHeartbeat(slug);
  
  // Aplicar jitter inicial
  const initialDelay = jitter(config.HEARTBEAT_HTTP_JITTER_MS);
  
  setTimeout(() => {
    // Primeiro heartbeat
    httpHeartbeat(slug, token);
    
    // Agendar próximos com jitter
    const intervalId = setInterval(() => {
      const delay = jitter(config.HEARTBEAT_HTTP_JITTER_MS);
      setTimeout(() => httpHeartbeat(slug, token), delay);
    }, config.HEARTBEAT_HTTP_INTERVAL_MS);
    
    activeIntervals.http.set(slug, intervalId);
    console.info('[HEARTBEAT][HTTP][START]', {
      slug,
      interval_ms: config.HEARTBEAT_HTTP_INTERVAL_MS,
      jitter_ms: config.HEARTBEAT_HTTP_JITTER_MS
    });
  }, initialDelay);
}

/**
 * Parar heartbeat HTTP para um bot
 */
function stopHttpHeartbeat(slug) {
  const intervalId = activeIntervals.http.get(slug);
  if (intervalId) {
    clearInterval(intervalId);
    activeIntervals.http.delete(slug);
    console.info('[HEARTBEAT][HTTP][STOP]', { slug });
  }
}

/**
 * Heartbeat PG
 */
async function pgHeartbeat(pool) {
  if (!pool) return;
  
  const start = Date.now();
  
  try {
    await pool.query('SELECT 1');
    const latency = Date.now() - start;
    
    metrics.pg.ok++;
    metrics.pg.latencies.push(latency);
    if (metrics.pg.latencies.length > 1000) {
      metrics.pg.latencies.shift();
    }
    
    observe('heartbeat_pg_latency_ms', latency);
    observe('heartbeat_pg_ok', 1);
    
    console.debug('[HEARTBEAT][PG][OK]', { latency_ms: latency });
  } catch (err) {
    metrics.pg.err++;
    observe('heartbeat_pg_err', 1);
    console.error('[HEARTBEAT][PG][ERR]', { error: err.message });
  }
}

/**
 * Iniciar heartbeat PG
 */
function startPgHeartbeat(pool) {
  // Parar se já existe
  stopPgHeartbeat();
  
  // Primeiro heartbeat
  pgHeartbeat(pool);
  
  // Agendar próximos
  activeIntervals.pg = setInterval(() => {
    pgHeartbeat(pool);
  }, config.HEARTBEAT_PG_INTERVAL_MS);
  
  console.info('[HEARTBEAT][PG][START]', {
    interval_ms: config.HEARTBEAT_PG_INTERVAL_MS
  });
}

/**
 * Parar heartbeat PG
 */
function stopPgHeartbeat() {
  if (activeIntervals.pg) {
    clearInterval(activeIntervals.pg);
    activeIntervals.pg = null;
    console.info('[HEARTBEAT][PG][STOP]');
  }
}

/**
 * Obter métricas de heartbeats
 */
function getMetrics() {
  const httpLatencies = metrics.http.latencies.slice().sort((a, b) => a - b);
  const httpP95Index = Math.floor(httpLatencies.length * 0.95);
  
  const pgLatencies = metrics.pg.latencies.slice().sort((a, b) => a - b);
  const pgP95Index = Math.floor(pgLatencies.length * 0.95);
  
  return {
    http: {
      ok: metrics.http.ok,
      err: metrics.http.err,
      latency_ms_p95: httpLatencies[httpP95Index] || 0,
      active_bots: activeIntervals.http.size
    },
    pg: {
      ok: metrics.pg.ok,
      err: metrics.pg.err,
      latency_ms_p95: pgLatencies[pgP95Index] || 0,
      active: activeIntervals.pg !== null
    }
  };
}

module.exports = {
  startHttpHeartbeat,
  stopHttpHeartbeat,
  startPgHeartbeat,
  stopPgHeartbeat,
  getMetrics
};
