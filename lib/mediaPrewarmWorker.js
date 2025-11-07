/**
 * Media Prewarm Worker v2.0
 * Executa aquecimento assíncrono de mídias com paralelismo
 * 
 * Melhorias v2.0:
 * - Queue O(1) (vs O(n) array.shift())
 * - Processamento paralelo (5x throughput)
 * - Métricas detalhadas
 * - Controle de concorrência
 */

const { downloadMedia } = require('./r2Service');
const { sendPhoto, sendVideo, sendDocument } = require('./telegramClient');
const { getTokenBySlug } = require('./tokenService');
const { updateCacheWithFileId, markCacheError } = require('./mediaService');
const { observe } = require('./metricsService');

// ========== QUEUE EFICIENTE O(1) ==========

class Queue {
  constructor() {
    this.items = {};
    this.head = 0;
    this.tail = 0;
  }
  
  enqueue(item) {
    this.items[this.tail] = item;
    this.tail++;
  }
  
  dequeue() {
    if (this.isEmpty()) return null;
    const item = this.items[this.head];
    delete this.items[this.head];
    this.head++;
    return item;
  }
  
  peek() {
    return this.isEmpty() ? null : this.items[this.head];
  }
  
  isEmpty() {
    return this.head === this.tail;
  }
  
  get length() {
    return this.tail - this.head;
  }
  
  toArray() {
    const arr = [];
    for (let i = this.head; i < this.tail; i++) {
      arr.push(this.items[i]);
    }
    return arr;
  }
  
  // Reordenar por prioridade (maior prioridade primeiro)
  sortByPriority() {
    const items = this.toArray();
    items.sort((a, b) => (b.priority || 0) - (a.priority || 0));
    
    // Reconstruir fila
    this.items = {};
    this.head = 0;
    this.tail = 0;
    items.forEach(item => this.enqueue(item));
  }
}

// ========== CONFIGURAÇÃO ==========

const prewarmQueue = new Queue();
const MAX_QUEUE_SIZE = 500;  // Tamanho máximo da fila
const MAX_CONCURRENCY = 5;   // Processar 5 mídias em paralelo
const WORKER_INTERVAL_MS = 2000;  // Intervalo de 2 segundos
const processing = new Set();

let activeWorkers = 0;
let workerTimer = null;

// ========== SISTEMA DE PRIORIZAÇÃO ==========

/**
 * Calcula prioridade de uma mídia para aquecimento
 * Prioridades maiores = processadas primeiro
 * 
 * Fatores:
 * - Mídias pequenas têm prioridade (mais rápidas)
 * - Fotos têm prioridade sobre vídeos
 * - Mídias recentes têm prioridade (provavelmente serão usadas logo)
 */
function calculatePriority(params) {
  const { kind, bytes, enqueued_at } = params;
  let priority = 100; // Base
  
  // Priorizar por tamanho (se disponível)
  if (bytes !== undefined) {
    if (bytes < 100_000) {        // < 100KB
      priority += 50;
    } else if (bytes < 1_000_000) { // < 1MB
      priority += 30;
    } else if (bytes < 5_000_000) { // < 5MB
      priority += 10;
    } else if (bytes > 20_000_000) { // > 20MB
      priority -= 20;
    }
  }
  
  // Priorizar por tipo
  if (kind === 'photo') {
    priority += 20; // Fotos são mais rápidas
  } else if (kind === 'video') {
    priority -= 10; // Vídeos são mais lentos
  }
  
  // Priorizar mídias recentes (enfileiradas há pouco tempo)
  if (enqueued_at) {
    const ageMinutes = (Date.now() - enqueued_at) / 60000;
    if (ageMinutes < 1) {
      priority += 15; // Muito recente
    } else if (ageMinutes > 10) {
      priority -= 5; // Já esperou muito
    }
  }
  
  return priority;
}

// ========== ENFILEIRAMENTO ==========

/**
 * Adiciona mídia à fila de aquecimento
 * @param {object} params - Parâmetros do aquecimento
 * @returns {boolean} true se enfileirado
 */
function enqueuePrewarm(params) {
  const { bot_slug, sha256, kind, r2_key, bytes } = params;
  
  const jobId = `${bot_slug}:${sha256}:${kind}`;
  
  if (processing.has(jobId)) {
    console.debug('[MEDIA][PREWARM][QUEUE][DUPLICATE]', { bot_slug, sha256, kind });
    observe('media_prewarm_queue_duplicate_total', 1, { bot: bot_slug });
    return false;
  }
  
  const queueItems = prewarmQueue.toArray();
  if (queueItems.some(j => j.jobId === jobId)) {
    console.debug('[MEDIA][PREWARM][QUEUE][ALREADY_QUEUED]', { bot_slug, sha256, kind });
    return false;
  }
  
  if (prewarmQueue.length >= MAX_QUEUE_SIZE) {
    console.warn('[MEDIA][PREWARM][QUEUE][FULL]', {
      bot_slug,
      sha256,
      kind,
      queue_size: prewarmQueue.length
    });
    observe('media_prewarm_queue_full_total', 1, { bot: bot_slug });
    return false;
  }
  
  const job = {
    jobId,
    bot_slug,
    sha256,
    kind,
    r2_key,
    bytes,
    enqueued_at: Date.now()
  };
  
  // Calcular prioridade
  job.priority = calculatePriority(job);
  
  prewarmQueue.enqueue(job);
  
  // Reordenar fila por prioridade a cada 10 jobs
  if (prewarmQueue.length % 10 === 0 && prewarmQueue.length > 5) {
    prewarmQueue.sortByPriority();
    console.debug('[MEDIA][PREWARM][QUEUE][REORDER]', {
      queue_size: prewarmQueue.length
    });
  }
  
  observe('media_prewarm_queued_total', 1, { bot: bot_slug, kind });
  
  console.info('[MEDIA][PREWARM][QUEUE][ADD]', {
    bot_slug,
    sha256,
    kind,
    priority: job.priority,
    queue_size: prewarmQueue.length,
    active_workers: activeWorkers
  });
  
  return true;
}

// ========== CACHE LOCAL DE DOWNLOADS R2 ==========

/**
 * Cache local temporário de downloads R2
 * Economiza 200-800ms por aquecimento e reduz bandwidth
 * TTL: 5 minutos (suficiente para aquecimento imediato após upload)
 */
const downloadCache = new Map(); // r2_key → {buffer, expires, hits}
const DOWNLOAD_CACHE_TTL = 5 * 60 * 1000; // 5 minutos
const MAX_DOWNLOAD_CACHE_SIZE = 50; // Máximo 50 mídias em cache (~50-500MB)

/**
 * Download de mídia do R2 com cache local
 */
async function downloadMediaCached(r2_key) {
  // Check cache
  const cached = downloadCache.get(r2_key);
  if (cached && cached.expires > Date.now()) {
    cached.hits++;
    console.debug('[MEDIA][PREWARM][DOWNLOAD_CACHE_HIT]', { 
      r2_key: r2_key.slice(0, 50), 
      hits: cached.hits,
      size_kb: Math.round(cached.buffer.length / 1024)
    });
    observe('media_prewarm_download_cache_hit_total', 1);
    return cached.buffer;
  }
  
  // Cache miss - download do R2
  observe('media_prewarm_download_cache_miss_total', 1);
  const buffer = await downloadMedia(r2_key);
  
  // Adicionar ao cache
  downloadCache.set(r2_key, {
    buffer,
    expires: Date.now() + DOWNLOAD_CACHE_TTL,
    hits: 0,
    cached_at: Date.now()
  });
  
  // Cleanup se cache ficar muito grande
  if (downloadCache.size > MAX_DOWNLOAD_CACHE_SIZE) {
    const sortedByAge = Array.from(downloadCache.entries())
      .sort((a, b) => a[1].cached_at - b[1].cached_at);
    
    // Remover 20% dos mais antigos
    const toRemove = Math.floor(MAX_DOWNLOAD_CACHE_SIZE * 0.2);
    for (let i = 0; i < toRemove; i++) {
      downloadCache.delete(sortedByAge[i][0]);
    }
    
    console.debug('[MEDIA][PREWARM][DOWNLOAD_CACHE_CLEANUP]', {
      removed: toRemove,
      remaining: downloadCache.size
    });
  }
  
  return buffer;
}

// ========== WARMUP CHAT ==========

const warmupChatCache = new Map();
const CACHE_TTL = 5 * 60 * 1000;

async function getWarmupChatId(pool, bot_slug) {
  const cached = warmupChatCache.get(bot_slug);
  if (cached && cached.expires > Date.now()) {
    return cached.chat_id;
  }
  
  try {
    const query = 'SELECT warmup_chat_id FROM bots WHERE slug = $1 AND deleted_at IS NULL';
    const result = await pool.query(query, [bot_slug]);
    
    if (result.rowCount === 0) {
      console.warn('[MEDIA][PREWARM][NO_BOT]', { bot_slug });
      return null;
    }
    
    const warmupChatId = result.rows[0].warmup_chat_id;
    
    if (!warmupChatId) {
      console.warn('[MEDIA][PREWARM][NO_WARMUP_CHAT]', { bot_slug });
      return null;
    }
    
    warmupChatCache.set(bot_slug, {
      chat_id: warmupChatId,
      expires: Date.now() + CACHE_TTL
    });
    
    return warmupChatId;
  } catch (err) {
    console.error('[MEDIA][PREWARM][GET_WARMUP_CHAT][ERR]', {
      bot_slug,
      error: err.message
    });
    
    return null;
  }
}

// ========== EXECUÇÃO ==========

async function executePrewarm(pool, job) {
  const { jobId, bot_slug, sha256, kind, r2_key, enqueued_at } = job;
  const startTime = Date.now();
  const queueWaitMs = startTime - enqueued_at;
  
  processing.add(jobId);
  
  try {
    console.info('[MEDIA][PREWARM][START]', {
      bot_slug,
      sha256,
      kind,
      r2_key,
      queue_wait_ms: queueWaitMs,
      active_workers: activeWorkers
    });
    
    const token = await getTokenBySlug(pool, bot_slug);
    if (!token) {
      throw new Error('BOT_TOKEN_NOT_SET');
    }
    
    const warmupChatId = await getWarmupChatId(pool, bot_slug);
    if (!warmupChatId) {
      throw new Error('WARMUP_CHAT_ID_NOT_SET');
    }
    
    const downloadStart = Date.now();
    const buffer = await downloadMediaCached(r2_key);
    const downloadMs = Date.now() - downloadStart;
    
    observe('media_prewarm_download_ms', downloadMs, { bot: bot_slug, kind });
    
    const sendStart = Date.now();
    let result;
    
    switch (kind) {
      case 'photo':
        result = await sendPhoto(token, warmupChatId, buffer, {
          filename: `${sha256}.jpg`
        });
        break;
      
      case 'video':
        result = await sendVideo(token, warmupChatId, buffer, {
          filename: `${sha256}.mp4`
        });
        break;
      
      case 'document':
      case 'audio':
        result = await sendDocument(token, warmupChatId, buffer, {
          filename: `${sha256}.bin`
        });
        break;
      
      default:
        throw new Error(`UNSUPPORTED_KIND: ${kind}`);
    }
    
    const sendMs = Date.now() - sendStart;
    observe('media_prewarm_send_ms', sendMs, { bot: bot_slug, kind });
    
    if (!result.ok) {
      throw new Error(result.error || result.description || 'SEND_FAILED');
    }
    
    await updateCacheWithFileId(pool, bot_slug, sha256, kind, {
      file_id: result.file_id,
      file_unique_id: result.file_unique_id,
      warmup_chat_id: warmupChatId,
      warmup_message_id: result.message_id
    });
    
    const totalMs = Date.now() - startTime;
    observe('media_prewarm_latency_ms', totalMs, { bot: bot_slug, kind });
    observe('media_prewarm_success_total', 1, { bot: bot_slug, kind });
    observe('media_prewarm_queue_wait_ms', queueWaitMs, { bot: bot_slug, kind });
    
    console.info('[MEDIA][PREWARM][OK]', {
      bot_slug,
      sha256,
      kind,
      file_id: result.file_id?.slice(0, 20) + '...',
      download_ms: downloadMs,
      send_ms: sendMs,
      total_ms: totalMs,
      queue_wait_ms: queueWaitMs
    });
    
    return {
      ok: true,
      file_id: result.file_id,
      total_ms: totalMs
    };
    
  } catch (err) {
    const totalMs = Date.now() - startTime;
    observe('media_prewarm_errors_total', 1, { bot: bot_slug, kind, error: err.message });
    
    console.error('[MEDIA][PREWARM][ERR]', {
      bot_slug,
      sha256,
      kind,
      error: err.message,
      total_ms: totalMs
    });
    
    await markCacheError(pool, bot_slug, sha256, kind, err.message).catch(e => {
      console.error('[MEDIA][PREWARM][MARK_ERROR][ERR]', { error: e.message });
    });
    
    return {
      ok: false,
      error: err.message,
      total_ms: totalMs
    };
    
  } finally {
    processing.delete(jobId);
  }
}

// ========== PROCESSAMENTO EM BATCH (PARALELO) ==========

/**
 * Processa próximos N jobs em paralelo
 * @param {object} pool - Pool do PostgreSQL
 * @returns {Promise<void>}
 */
async function processNextBatch(pool) {
  if (prewarmQueue.isEmpty()) {
    observe('media_prewarm_queue_size', 0);
    observe('media_prewarm_active_workers', activeWorkers);
    return;
  }
  
  const availableSlots = MAX_CONCURRENCY - activeWorkers;
  if (availableSlots <= 0) {
    return;
  }
  
  const batch = [];
  const batchSize = Math.min(availableSlots, prewarmQueue.length);
  
  for (let i = 0; i < batchSize; i++) {
    const job = prewarmQueue.dequeue();
    
    if (!job) break;
    
    if (processing.has(job.jobId)) {
      continue;
    }
    
    activeWorkers++;
    batch.push(
      executePrewarm(pool, job)
        .finally(() => {
          activeWorkers--;
        })
    );
  }
  
  if (batch.length === 0) {
    return;
  }
  
  observe('media_prewarm_batch_size', batch.length);
  observe('media_prewarm_queue_size', prewarmQueue.length);
  observe('media_prewarm_active_workers', activeWorkers);
  
  console.debug('[MEDIA][PREWARM][BATCH][START]', {
    batch_size: batch.length,
    queue_remaining: prewarmQueue.length,
    active_workers: activeWorkers
  });
  
  const results = await Promise.allSettled(batch);
  
  const successful = results.filter(r => 
    r.status === 'fulfilled' && r.value?.ok
  ).length;
  
  const failed = batch.length - successful;
  
  console.info('[MEDIA][PREWARM][BATCH][DONE]', {
    batch_size: batch.length,
    successful,
    failed,
    queue_remaining: prewarmQueue.length,
    active_workers: activeWorkers
  });
}

// ========== WORKER LIFECYCLE ==========

function startPrewarmWorker(pool, intervalMs = WORKER_INTERVAL_MS) {
  if (workerTimer) {
    console.warn('[MEDIA][PREWARM][WORKER][ALREADY_RUNNING]');
    return getWorkerController();
  }
  
  console.info('[MEDIA][PREWARM][WORKER][START]', { 
    interval_ms: intervalMs,
    concurrency: MAX_CONCURRENCY,
    max_queue_size: MAX_QUEUE_SIZE
  });
  
  workerTimer = setInterval(() => {
    processNextBatch(pool).catch(err => {
      console.error('[MEDIA][PREWARM][WORKER][ERR]', { 
        error: err.message
      });
    });
  }, intervalMs);
  
  workerTimer.unref();
  
  return getWorkerController();
}

function getWorkerController() {
  return {
    stop: () => {
      if (workerTimer) {
        clearInterval(workerTimer);
        workerTimer = null;
        console.info('[MEDIA][PREWARM][WORKER][STOP]');
      }
    },
    getQueueSize: () => prewarmQueue.length,
    getProcessingCount: () => processing.size,
    getActiveWorkers: () => activeWorkers,
    getMaxConcurrency: () => MAX_CONCURRENCY,
    getQueueItems: () => prewarmQueue.toArray(),
    isRunning: () => workerTimer !== null
  };
}

function getQueueMetrics() {
  const utilization = MAX_CONCURRENCY > 0 ? activeWorkers / MAX_CONCURRENCY : 0;
  
  return {
    queue_size: prewarmQueue.length,
    processing_count: processing.size,
    active_workers: activeWorkers,
    max_concurrency: MAX_CONCURRENCY,
    max_queue_size: MAX_QUEUE_SIZE,
    utilization: Math.round(utilization * 100) / 100,
    utilization_pct: Math.round(utilization * 100)
  };
}

module.exports = {
  enqueuePrewarm,
  startPrewarmWorker,
  getQueueMetrics,
  getWorkerController
};
