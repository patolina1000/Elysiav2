/**
 * Serviço de métricas para observabilidade completa
 * Telemetria obrigatória:
 * - Por envio: send_attempt_ms, telegram_http_ms, priority, chat_id
 * - Por fila: queue_len_global, queue_wait_ms_p95/p99 (global e por prioridade)
 * - Por chat: per_chat_queue_len, per_chat_delay_ms
 * - 429: contadores globais e por chat, backoff aplicado
 * - Heartbeats: heartbeat_http_ok/err, heartbeat_http_latency_ms_p95
 * - Webhook: ack_ms, done_ms
 */

const metrics = {
  // Webhook
  webhook_ack: new Map(), // slug -> [latencies]
  webhook_done: new Map(), // slug -> [latencies]
  
  // Start
  start_enqueue: new Map(),
  start_first_send_latency: new Map(), // slug -> [latencies]
  start_funnel_insert: new Map(),
  start_config_used: new Map(), // slug:active -> count
  
  // Send
  send_attempt: new Map(), // key: slug:priority -> [latencies]
  telegram_http: new Map(), // key: slug:priority -> [latencies]
  
  // Queue
  queue_len_global: [],
  queue_wait: new Map(), // key: priority -> [latencies]
  per_chat_queue_len: new Map(), // chat_id -> [lengths]
  per_chat_delay: new Map(), // chat_id -> [delays]
  
  // 429 & Backoff
  backoff_429_count: 0,
  backoff_429_per_chat: new Map(), // chat_id -> count
  
  // Heartbeats
  heartbeat_http_ok: 0,
  heartbeat_http_err: 0,
  heartbeat_http_latency: [],
  heartbeat_pg_ok: 0,
  heartbeat_pg_err: 0,
  heartbeat_pg_latency: [],
};

const MAX_SAMPLES = 1000;

/**
 * Registra uma observação de métrica
 * @param {string} name - Nome da métrica
 * @param {number} value - Valor
 * @param {object} labels - Labels como { bot: 'slug', priority: 1, chat_id: '123' }
 */
function observe(name, value, labels = {}) {
  const bot = labels.bot || 'unknown';
  const priority = labels.priority;
  const chatId = labels.chat_id;
  
  // Webhook
  if (name === 'webhook_ack_ms') {
    if (!metrics.webhook_ack.has(bot)) metrics.webhook_ack.set(bot, []);
    pushSample(metrics.webhook_ack.get(bot), value);
  }
  else if (name === 'webhook_done_ms') {
    if (!metrics.webhook_done.has(bot)) metrics.webhook_done.set(bot, []);
    pushSample(metrics.webhook_done.get(bot), value);
  }
  
  // Start
  else if (name === 'start_enqueue_ms') {
    if (!metrics.start_enqueue.has(bot)) metrics.start_enqueue.set(bot, []);
    pushSample(metrics.start_enqueue.get(bot), value);
  }
  else if (name === 'start_first_send_latency_ms') {
    if (!metrics.start_first_send_latency.has(bot)) metrics.start_first_send_latency.set(bot, []);
    pushSample(metrics.start_first_send_latency.get(bot), value);
  }
  else if (name === 'start_funnel_insert_ms') {
    if (!metrics.start_funnel_insert.has(bot)) metrics.start_funnel_insert.set(bot, []);
    pushSample(metrics.start_funnel_insert.get(bot), value);
  }
  else if (name === 'start_config_used_total') {
    const active = labels.active ? 'true' : 'false';
    const key = `${bot}:${active}`;
    metrics.start_config_used.set(key, (metrics.start_config_used.get(key) || 0) + 1);
  }
  
  // Send
  else if (name === 'send_attempt_ms') {
    const key = `${bot}:${priority || 'unknown'}`;
    if (!metrics.send_attempt.has(key)) metrics.send_attempt.set(key, []);
    pushSample(metrics.send_attempt.get(key), value);
  }
  else if (name === 'telegram_http_ms') {
    const key = `${bot}:${priority || 'unknown'}`;
    if (!metrics.telegram_http.has(key)) metrics.telegram_http.set(key, []);
    pushSample(metrics.telegram_http.get(key), value);
  }
  
  // Queue
  else if (name === 'queue_len_global') {
    pushSample(metrics.queue_len_global, value);
  }
  else if (name === 'queue_wait_ms') {
    const key = String(priority || 'unknown');
    if (!metrics.queue_wait.has(key)) metrics.queue_wait.set(key, []);
    pushSample(metrics.queue_wait.get(key), value);
  }
  else if (name === 'per_chat_queue_len') {
    const key = String(chatId || 'unknown');
    if (!metrics.per_chat_queue_len.has(key)) metrics.per_chat_queue_len.set(key, []);
    pushSample(metrics.per_chat_queue_len.get(key), value);
  }
  else if (name === 'per_chat_delay_ms') {
    const key = String(chatId || 'unknown');
    if (!metrics.per_chat_delay.has(key)) metrics.per_chat_delay.set(key, []);
    pushSample(metrics.per_chat_delay.get(key), value);
  }
  
  // 429 & Backoff
  else if (name === 'backoff_429_count') {
    metrics.backoff_429_count += value;
  }
  else if (name === 'backoff_429_per_chat') {
    const key = String(chatId || 'unknown');
    metrics.backoff_429_per_chat.set(key, (metrics.backoff_429_per_chat.get(key) || 0) + value);
  }
  
  // Heartbeats
  else if (name === 'heartbeat_http_ok') {
    metrics.heartbeat_http_ok += value;
  }
  else if (name === 'heartbeat_http_err') {
    metrics.heartbeat_http_err += value;
  }
  else if (name === 'heartbeat_http_latency_ms') {
    pushSample(metrics.heartbeat_http_latency, value);
  }
  else if (name === 'heartbeat_pg_ok') {
    metrics.heartbeat_pg_ok += value;
  }
  else if (name === 'heartbeat_pg_err') {
    metrics.heartbeat_pg_err += value;
  }
  else if (name === 'heartbeat_pg_latency_ms') {
    pushSample(metrics.heartbeat_pg_latency, value);
  }
}

/**
 * Helper para adicionar sample e limitar tamanho
 */
function pushSample(array, value) {
  array.push(value);
  if (array.length > MAX_SAMPLES) {
    array.shift();
  }
}

/**
 * Calcula percentis de uma lista de valores
 */
function calculatePercentiles(values) {
  if (values.length === 0) return { p50: 0, p95: 0, p99: 0, avg: 0, count: 0 };
  
  const sorted = [...values].sort((a, b) => a - b);
  const count = sorted.length;
  
  const p50 = sorted[Math.floor(count * 0.5)] || 0;
  const p95 = sorted[Math.floor(count * 0.95)] || 0;
  const p99 = sorted[Math.floor(count * 0.99)] || 0;
  const avg = sorted.reduce((a, b) => a + b, 0) / count;
  
  return { p50, p95, p99, avg, count };
}

/**
 * Obtém snapshot de todas as métricas
 */
function getMetrics() {
  const result = {
    webhook: {
      ack_ms: {},
      done_ms: {}
    },
    start: {
      enqueue_ms: {},
      first_send_latency_ms: {},
      funnel_insert_ms: {},
      config_used_total: {}
    },
    send: {
      attempt_ms: {},
      telegram_http_ms: {}
    },
    queue: {
      len_global: calculatePercentiles(metrics.queue_len_global),
      wait_ms: {},
      per_chat_queue_len: {},
      per_chat_delay_ms: {}
    },
    backoff_429: {
      count: metrics.backoff_429_count,
      per_chat: Object.fromEntries(metrics.backoff_429_per_chat)
    },
    heartbeat: {
      http: {
        ok: metrics.heartbeat_http_ok,
        err: metrics.heartbeat_http_err,
        latency_ms_p95: calculatePercentiles(metrics.heartbeat_http_latency).p95
      },
      pg: {
        ok: metrics.heartbeat_pg_ok,
        err: metrics.heartbeat_pg_err,
        latency_ms_p95: calculatePercentiles(metrics.heartbeat_pg_latency).p95
      }
    }
  };
  
  // Webhook
  for (const [bot, values] of metrics.webhook_ack.entries()) {
    result.webhook.ack_ms[bot] = calculatePercentiles(values);
  }
  for (const [bot, values] of metrics.webhook_done.entries()) {
    result.webhook.done_ms[bot] = calculatePercentiles(values);
  }
  
  // Start
  for (const [bot, values] of metrics.start_enqueue.entries()) {
    result.start.enqueue_ms[bot] = calculatePercentiles(values);
  }
  for (const [bot, values] of metrics.start_first_send_latency.entries()) {
    result.start.first_send_latency_ms[bot] = calculatePercentiles(values);
  }
  for (const [bot, values] of metrics.start_funnel_insert.entries()) {
    result.start.funnel_insert_ms[bot] = calculatePercentiles(values);
  }
  for (const [key, count] of metrics.start_config_used.entries()) {
    result.start.config_used_total[key] = count;
  }
  
  // Send
  for (const [key, values] of metrics.send_attempt.entries()) {
    result.send.attempt_ms[key] = calculatePercentiles(values);
  }
  for (const [key, values] of metrics.telegram_http.entries()) {
    result.send.telegram_http_ms[key] = calculatePercentiles(values);
  }
  
  // Queue
  for (const [priority, values] of metrics.queue_wait.entries()) {
    result.queue.wait_ms[priority] = calculatePercentiles(values);
  }
  for (const [chatId, values] of metrics.per_chat_queue_len.entries()) {
    result.queue.per_chat_queue_len[chatId] = calculatePercentiles(values);
  }
  for (const [chatId, values] of metrics.per_chat_delay.entries()) {
    result.queue.per_chat_delay_ms[chatId] = calculatePercentiles(values);
  }
  
  return result;
}

/**
 * Registra latência do /start (compatibilidade)
 */
function recordStartLatency(botSlug, tookMs) {
  observe('send_attempt_ms', tookMs, { bot: botSlug });
  console.info('[METRIC][start_first_send.latency_ms]', { bot: botSlug, took_ms: Math.round(tookMs) });
}

module.exports = {
  observe,
  getMetrics,
  recordStartLatency
};
