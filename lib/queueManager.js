/**
 * Gerenciador de fila com prioridades, rate limiting e backoff para 429
 * Implementa token bucket para global e por chat
 */

const config = require('../config/rate');
const { observe } = require('./metricsService');

// Fila global com prioridades
const globalQueue = {
  [config.PRIORITY.START]: [],
  [config.PRIORITY.DISPARO]: [],
  [config.PRIORITY.DOWNSELL]: []
};

// Token bucket global
const globalBucket = {
  tokens: config.RATE_GLOBAL_RPS,
  maxTokens: config.RATE_GLOBAL_RPS,
  burstTokens: config.BURST_SIZE,
  lastRefill: Date.now()
};

// Token buckets por chat
const chatBuckets = new Map();

// Backoff por chat (após 429)
const chatBackoffs = new Map();

// Fallback por chat (após 429 repetido)
const chatFallbacks = new Map();

// Métricas
const metrics = {
  queue_len_global: 0,
  queue_wait_times: [],
  per_chat_queue_len: new Map(),
  backoff_429_count: 0,
  backoff_429_per_chat: new Map()
};

/**
 * Obter ou criar bucket para um chat
 */
function getChatBucket(chatId) {
  if (!chatBuckets.has(chatId)) {
    chatBuckets.set(chatId, {
      tokens: config.RATE_PER_CHAT_RPS,
      maxTokens: config.RATE_PER_CHAT_RPS,
      burstTokens: config.BURST_SIZE,
      lastRefill: Date.now()
    });
  }
  return chatBuckets.get(chatId);
}

/**
 * Verificar se chat está em fallback (após 429 repetido)
 */
function isInFallback(chatId) {
  const fallback = chatFallbacks.get(chatId);
  if (!fallback) return false;
  
  const now = Date.now();
  if (now - fallback.startedAt > config.FALLBACK_DURATION_MS) {
    // Recuperar gradualmente
    const elapsed = now - fallback.startedAt;
    const cycles = Math.floor(elapsed / config.FALLBACK_DURATION_MS);
    const recoveredRps = Math.min(
      config.RATE_PER_CHAT_RPS,
      config.FALLBACK_CHAT_RPS + (cycles * config.FALLBACK_RECOVERY_STEP)
    );
    
    if (recoveredRps >= config.RATE_PER_CHAT_RPS) {
      chatFallbacks.delete(chatId);
      return false;
    }
    
    fallback.currentRps = recoveredRps;
  }
  
  return true;
}

/**
 * Obter RPS atual para um chat (considerando fallback)
 */
function getChatRps(chatId) {
  const fallback = chatFallbacks.get(chatId);
  if (fallback && isInFallback(chatId)) {
    return fallback.currentRps;
  }
  return config.RATE_PER_CHAT_RPS;
}

/**
 * Refill de tokens (token bucket)
 */
function refillBucket(bucket, rps) {
  const now = Date.now();
  const elapsed = (now - bucket.lastRefill) / 1000;
  const tokensToAdd = elapsed * rps;
  
  if (tokensToAdd > 0) {
    bucket.tokens = Math.min(bucket.maxTokens + bucket.burstTokens, bucket.tokens + tokensToAdd);
    bucket.lastRefill = now;
  }
}

/**
 * Verificar se há tokens disponíveis
 */
function hasTokens(bucket) {
  return bucket.tokens >= 1;
}

/**
 * Consumir um token
 */
function consumeToken(bucket) {
  if (bucket.tokens >= 1) {
    bucket.tokens--;
    return true;
  }
  return false;
}

/**
 * Enfileirar envio com prioridade
 */
function enqueue(priority, chatId, callback, metadata = {}) {
  const queuedAt = Date.now();
  
  const item = {
    priority,
    chatId,
    callback,
    metadata,
    queuedAt,
    attempts: 0
  };
  
  // Adicionar na fila de prioridade correta
  if (!globalQueue[priority]) {
    globalQueue[priority] = [];
  }
  globalQueue[priority].push(item);
  
  // Atualizar métricas
  metrics.queue_len_global++;
  const chatQueueLen = metrics.per_chat_queue_len.get(chatId) || 0;
  metrics.per_chat_queue_len.set(chatId, chatQueueLen + 1);
  
  observe('queue_len_global', metrics.queue_len_global);
  observe('per_chat_queue_len', chatQueueLen + 1, { chat_id: chatId });
  
  // Processar fila
  setImmediate(() => processQueue());
  
  return item;
}

/**
 * Obter próximo item da fila (por prioridade)
 */
function dequeue() {
  // Tentar por ordem de prioridade: START > DISPARO > DOWNSELL
  const priorities = [
    config.PRIORITY.START,
    config.PRIORITY.DISPARO,
    config.PRIORITY.DOWNSELL
  ];
  
  for (const priority of priorities) {
    const queue = globalQueue[priority];
    if (queue && queue.length > 0) {
      return queue.shift();
    }
  }
  
  return null;
}

/**
 * Verificar se chat está em backoff (após 429)
 */
function isInBackoff(chatId) {
  const backoff = chatBackoffs.get(chatId);
  if (!backoff) return false;
  
  const now = Date.now();
  if (now >= backoff.until) {
    chatBackoffs.delete(chatId);
    return false;
  }
  
  return true;
}

/**
 * Aplicar backoff após 429
 */
function applyBackoff(chatId, retryAfter = null) {
  const now = Date.now();
  const existing = chatBackoffs.get(chatId);
  
  let backoffMs;
  if (retryAfter) {
    // Telegram forneceu retry_after
    backoffMs = retryAfter * 1000;
  } else if (existing) {
    // Dobrar backoff exponencialmente
    backoffMs = Math.min(
      existing.backoffMs * config.BACKOFF_429_MULTIPLIER,
      config.BACKOFF_429_MAX_MS
    );
  } else {
    // Primeiro 429
    backoffMs = config.BACKOFF_429_INITIAL_MS;
  }
  
  chatBackoffs.set(chatId, {
    backoffMs,
    until: now + backoffMs,
    count: (existing?.count || 0) + 1
  });
  
  // Atualizar métricas
  metrics.backoff_429_count++;
  const chatCount = metrics.backoff_429_per_chat.get(chatId) || 0;
  metrics.backoff_429_per_chat.set(chatId, chatCount + 1);
  
  observe('backoff_429_count', metrics.backoff_429_count);
  observe('backoff_429_per_chat', chatCount + 1, { chat_id: chatId });
  
  // Se 429 repetido (>= 3x), aplicar fallback
  const backoff = chatBackoffs.get(chatId);
  if (backoff.count >= 3 && !chatFallbacks.has(chatId)) {
    chatFallbacks.set(chatId, {
      startedAt: now,
      currentRps: config.FALLBACK_CHAT_RPS
    });
    console.warn('[QUEUE][FALLBACK]', {
      chat_id: chatId,
      fallback_rps: config.FALLBACK_CHAT_RPS,
      duration_ms: config.FALLBACK_DURATION_MS
    });
  }
  
  console.warn('[QUEUE][BACKOFF]', {
    chat_id: chatId,
    backoff_ms: backoffMs,
    until: new Date(now + backoffMs).toISOString(),
    count: backoff.count
  });
}

/**
 * Processar fila
 */
async function processQueue() {
  // Refill global bucket
  refillBucket(globalBucket, config.RATE_GLOBAL_RPS);
  
  // Verificar se há tokens globais
  if (!hasTokens(globalBucket)) {
    // Agendar próxima tentativa
    setTimeout(() => processQueue(), 100);
    return;
  }
  
  // Obter próximo item (por prioridade)
  const item = dequeue();
  if (!item) {
    return; // Fila vazia
  }
  
  const { priority, chatId, callback, metadata, queuedAt, attempts } = item;
  
  // Verificar se chat está em backoff
  if (isInBackoff(chatId)) {
    // Re-enfileirar no final
    globalQueue[priority].push(item);
    setTimeout(() => processQueue(), 100);
    return;
  }
  
  // Refill bucket do chat
  const chatBucket = getChatBucket(chatId);
  const chatRps = getChatRps(chatId);
  refillBucket(chatBucket, chatRps);
  
  // Verificar se há tokens para este chat
  if (!hasTokens(chatBucket)) {
    // Re-enfileirar no final
    globalQueue[priority].push(item);
    setTimeout(() => processQueue(), 100);
    return;
  }
  
  // Consumir tokens
  consumeToken(globalBucket);
  consumeToken(chatBucket);
  
  // Atualizar métricas
  metrics.queue_len_global--;
  const chatQueueLen = metrics.per_chat_queue_len.get(chatId) || 0;
  metrics.per_chat_queue_len.set(chatId, Math.max(0, chatQueueLen - 1));
  
  const queueWaitMs = Date.now() - queuedAt;
  metrics.queue_wait_times.push(queueWaitMs);
  if (metrics.queue_wait_times.length > 1000) {
    metrics.queue_wait_times.shift();
  }
  
  observe('queue_len_global', metrics.queue_len_global);
  observe('queue_wait_ms', queueWaitMs, { priority, chat_id: chatId });
  
  // Executar callback
  try {
    const result = await callback();
    
    // Verificar se foi 429
    if (result && result.error === 'RATE_LIMIT_EXCEEDED') {
      const retryAfter = result.retry_after_seconds || result.retry_after || null;
      applyBackoff(chatId, retryAfter);
      
      // Re-enfileirar se não excedeu tentativas
      if (attempts < 5) {
        item.attempts++;
        globalQueue[priority].unshift(item); // Adicionar no início da fila de prioridade
        console.info('[QUEUE][429_RETRY]', {
          chat_id: chatId,
          priority,
          attempt: item.attempts,
          retry_after: retryAfter
        });
      } else {
        console.error('[QUEUE][MAX_RETRIES]', { chat_id: chatId, priority, attempts });
      }
    }
  } catch (err) {
    console.error('[QUEUE][PROCESS_ERR]', {
      chat_id: chatId,
      priority,
      error: err.message
    });
  }
  
  // Continuar processando
  setImmediate(() => processQueue());
}

/**
 * Obter métricas da fila
 */
function getMetrics() {
  const waitTimes = metrics.queue_wait_times.slice().sort((a, b) => a - b);
  const p95Index = Math.floor(waitTimes.length * 0.95);
  const p99Index = Math.floor(waitTimes.length * 0.99);
  
  return {
    queue_len_global: metrics.queue_len_global,
    queue_wait_ms_p95: waitTimes[p95Index] || 0,
    queue_wait_ms_p99: waitTimes[p99Index] || 0,
    per_chat_queue_len: Object.fromEntries(metrics.per_chat_queue_len),
    backoff_429_count: metrics.backoff_429_count,
    backoff_429_per_chat: Object.fromEntries(metrics.backoff_429_per_chat),
    active_chats: chatBuckets.size,
    chats_in_backoff: chatBackoffs.size,
    chats_in_fallback: chatFallbacks.size
  };
}

/**
 * Iniciar processamento da fila
 */
function start() {
  console.info('[QUEUE] Iniciado com config:', {
    rate_per_chat_rps: config.RATE_PER_CHAT_RPS,
    rate_global_rps: config.RATE_GLOBAL_RPS,
    burst_size: config.BURST_SIZE
  });
  
  // Processar continuamente
  setInterval(() => {
    if (metrics.queue_len_global > 0) {
      processQueue();
    }
  }, 50);
}

module.exports = {
  enqueue,
  getMetrics,
  start
};
