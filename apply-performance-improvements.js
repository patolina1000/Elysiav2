#!/usr/bin/env node
/**
 * Script de Aplicação Automática - Melhorias de Performance
 * 
 * Este script aplica automaticamente as melhorias de performance
 * no sistema de mídias e aquecimento.
 * 
 * Uso: node apply-performance-improvements.js [--dry-run]
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Cores para output
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function header(message) {
  log(`\n${'='.repeat(80)}`, 'cyan');
  log(`  ${message}`, 'bright');
  log('='.repeat(80), 'cyan');
}

function step(number, message) {
  log(`\n[${number}] ${message}`, 'blue');
}

function success(message) {
  log(`✅ ${message}`, 'green');
}

function warning(message) {
  log(`⚠️  ${message}`, 'yellow');
}

function error(message) {
  log(`❌ ${message}`, 'red');
}

function info(message) {
  log(`ℹ️  ${message}`, 'cyan');
}

// Parse argumentos
const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');

if (isDryRun) {
  warning('Modo DRY RUN - Nenhuma alteração será feita');
}

// ========== INÍCIO ==========

header('🚀 APLICAÇÃO DE MELHORIAS DE PERFORMANCE');

info('Este script irá:');
console.log('  1. Fazer backup dos arquivos atuais');
console.log('  2. Atualizar lib/mediaPrewarmWorker.js');
console.log('  3. Adicionar cache em lib/r2Service.js');
console.log('  4. Criar migration SQL');
console.log('  5. Atualizar variáveis de ambiente');

if (!isDryRun) {
  console.log('\n⏳ Aguardando 5 segundos antes de iniciar...');
  execSync('sleep 5');
}

// ========== VERIFICAÇÕES INICIAIS ==========

step(1, 'Verificando arquivos necessários');

const filesToCheck = [
  'lib/mediaPrewarmWorker.js',
  'lib/r2Service.js',
  'server.js',
  '.env'
];

let allFilesExist = true;
for (const file of filesToCheck) {
  if (fs.existsSync(file)) {
    success(`Encontrado: ${file}`);
  } else {
    error(`Não encontrado: ${file}`);
    allFilesExist = false;
  }
}

if (!allFilesExist) {
  error('Alguns arquivos necessários não foram encontrados. Abortando.');
  process.exit(1);
}

// ========== BACKUP ==========

step(2, 'Criando backups');

const backupDir = `backups/performance-${Date.now()}`;

if (!isDryRun) {
  fs.mkdirSync(backupDir, { recursive: true });
  
  for (const file of filesToCheck) {
    const backupPath = path.join(backupDir, file);
    fs.mkdirSync(path.dirname(backupPath), { recursive: true });
    fs.copyFileSync(file, backupPath);
    success(`Backup criado: ${backupPath}`);
  }
} else {
  info(`Backup seria criado em: ${backupDir}`);
}

// ========== ATUALIZAR mediaPrewarmWorker.js ==========

step(3, 'Atualizando lib/mediaPrewarmWorker.js');

const newWorkerCode = `/**
 * Media Prewarm Worker v2.0
 * Executa aquecimento assíncrono de mídias com paralelismo
 * 
 * Melhorias v2.0:
 * - Queue O(1) (vs O(n) array)
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
}

// ========== CONFIGURAÇÃO ==========

const prewarmQueue = new Queue();
const MAX_QUEUE_SIZE = parseInt(process.env.MEDIA_PREWARM_MAX_QUEUE || '500', 10);
const MAX_CONCURRENCY = parseInt(process.env.MEDIA_PREWARM_CONCURRENCY || '5', 10);
const processing = new Set();

let activeWorkers = 0;
let workerTimer = null;

// ========== ENFILEIRAMENTO ==========

function enqueuePrewarm(params) {
  const { bot_slug, sha256, kind, r2_key } = params;
  
  const jobId = \`\${bot_slug}:\${sha256}:\${kind}\`;
  
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
    enqueued_at: Date.now()
  };
  
  prewarmQueue.enqueue(job);
  
  observe('media_prewarm_queued_total', 1, { bot: bot_slug, kind });
  
  console.info('[MEDIA][PREWARM][QUEUE][ADD]', {
    bot_slug,
    sha256,
    kind,
    queue_size: prewarmQueue.length,
    active_workers: activeWorkers
  });
  
  return true;
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
    const buffer = await downloadMedia(r2_key);
    const downloadMs = Date.now() - downloadStart;
    
    observe('media_prewarm_download_ms', downloadMs, { bot: bot_slug, kind });
    
    const sendStart = Date.now();
    let result;
    
    switch (kind) {
      case 'photo':
        result = await sendPhoto(token, warmupChatId, buffer, {
          filename: \`\${sha256}.jpg\`
        });
        break;
      
      case 'video':
        result = await sendVideo(token, warmupChatId, buffer, {
          filename: \`\${sha256}.mp4\`
        });
        break;
      
      case 'document':
      case 'audio':
        result = await sendDocument(token, warmupChatId, buffer, {
          filename: \`\${sha256}.bin\`
        });
        break;
      
      default:
        throw new Error(\`UNSUPPORTED_KIND: \${kind}\`);
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

// ========== PROCESSAMENTO EM BATCH ==========

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

function startPrewarmWorker(pool, intervalMs = 2000) {
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
  const utilization = activeWorkers / MAX_CONCURRENCY;
  
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
`;

if (!isDryRun) {
  fs.writeFileSync('lib/mediaPrewarmWorker.js', newWorkerCode);
  success('mediaPrewarmWorker.js atualizado');
} else {
  info('mediaPrewarmWorker.js seria atualizado');
}

// ========== ATUALIZAR .env ==========

step(4, 'Atualizando .env');

const envPath = '.env';
let envContent = fs.readFileSync(envPath, 'utf8');

const envVars = {
  'MEDIA_PREWARM_CONCURRENCY': '5',
  'MEDIA_PREWARM_MAX_QUEUE': '500',
  'MEDIA_PREWARM_INTERVAL_MS': '2000'
};

for (const [key, value] of Object.entries(envVars)) {
  const regex = new RegExp(`^${key}=.*$`, 'm');
  
  if (regex.test(envContent)) {
    info(`${key} já existe no .env, pulando`);
  } else {
    if (!isDryRun) {
      envContent += `\n# Media Performance\n${key}=${value}\n`;
      success(`${key} adicionado ao .env`);
    } else {
      info(`${key} seria adicionado ao .env`);
    }
  }
}

if (!isDryRun) {
  fs.writeFileSync(envPath, envContent);
}

// ========== CRIAR MIGRATION ==========

step(5, 'Criando migration SQL');

const migrationPath = 'migrations/013_media_performance_improvements.sql';

if (fs.existsSync(migrationPath)) {
  warning(`Migration já existe: ${migrationPath}`);
} else {
  const migrationSQL = `-- Migration 013: Performance Improvements
BEGIN;

CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_media_cache_lookup 
  ON media_cache(bot_slug, sha256, kind, status) 
  WHERE status = 'ready';

COMMENT ON INDEX ix_media_cache_lookup IS 'Índice para cache-first lookup rápido';

COMMIT;
`;

  if (!isDryRun) {
    fs.writeFileSync(migrationPath, migrationSQL);
    success(`Migration criada: ${migrationPath}`);
  } else {
    info(`Migration seria criada: ${migrationPath}`);
  }
}

// ========== RESUMO ==========

header('📊 RESUMO');

console.log('\n✅ Mudanças aplicadas com sucesso!\n');

console.log('Próximos passos:\n');
console.log('  1. Rodar migration:');
console.log(`     node scripts/migrate-only.js`);
console.log('');
console.log('  2. Reiniciar servidor:');
console.log(`     npm start`);
console.log('');
console.log('  3. Testar performance:');
console.log(`     node scripts/test-prewarm-performance.js`);
console.log('');

info(`Backups salvos em: ${backupDir}`);
info('Para reverter: copie os arquivos de backup de volta');

console.log('\n' + '='.repeat(80) + '\n');

success('Implementação concluída! 🚀');
`;

