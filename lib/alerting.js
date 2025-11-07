/**
 * Sistema de Alerting para monitoramento proativo
 * Detecta anomalias e envia alertas
 */

// Thresholds para alertas
const THRESHOLDS = {
  ERROR_RATE: 0.05, // 5% de erro é crítico
  LATENCY_P95: 1000, // P95 > 1s é alerta
  RATE_LIMIT_HIT_RATE: 0.10, // 10% de requests com rate limit é alerta
  MEMORY_USAGE_MB: 512, // > 512MB de heap é warning
  DATABASE_LATENCY_MS: 100, // > 100ms é warning
  QUEUE_SIZE: 50 // > 50 items na fila é warning
};

// Histórico de alertas (evita spam)
const alertHistory = new Map();
const ALERT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutos entre alertas do mesmo tipo

/**
 * Níveis de severidade
 */
const SEVERITY = {
  INFO: 'info',
  WARNING: 'warning',
  ERROR: 'error',
  CRITICAL: 'critical'
};

/**
 * Verifica se deve enviar alerta (cooldown)
 */
function shouldSendAlert(alertType) {
  const lastSent = alertHistory.get(alertType);
  const now = Date.now();
  
  if (!lastSent || (now - lastSent) > ALERT_COOLDOWN_MS) {
    alertHistory.set(alertType, now);
    return true;
  }
  
  return false;
}

/**
 * Envia alerta (log estruturado + future: webhook/email)
 */
function sendAlert(severity, type, message, metadata = {}) {
  const alert = {
    timestamp: new Date().toISOString(),
    severity,
    type,
    message,
    metadata,
    hostname: process.env.HOSTNAME || 'unknown',
    environment: process.env.NODE_ENV || 'development'
  };
  
  // Log estruturado
  if (severity === SEVERITY.CRITICAL || severity === SEVERITY.ERROR) {
    console.error('[ALERT]', JSON.stringify(alert));
  } else if (severity === SEVERITY.WARNING) {
    console.warn('[ALERT]', JSON.stringify(alert));
  } else {
    console.info('[ALERT]', JSON.stringify(alert));
  }
  
  // TODO: Integrar com serviços externos
  // - Webhook para Slack/Discord
  // - Email via SendGrid/AWS SES
  // - PagerDuty para critical
  // - Datadog/NewRelic APM
  
  return alert;
}

/**
 * Monitora taxa de erro
 */
function checkErrorRate(metrics) {
  if (!metrics || !metrics.send) return;
  
  let totalOk = 0;
  let totalErr = 0;
  
  // Somar métricas de sucesso
  for (const count of (metrics.send.ok || new Map()).values()) {
    totalOk += count;
  }
  
  // Somar métricas de erro
  for (const count of (metrics.send.err || new Map()).values()) {
    totalErr += count;
  }
  
  const total = totalOk + totalErr;
  if (total === 0) return;
  
  const errorRate = totalErr / total;
  
  if (errorRate > THRESHOLDS.ERROR_RATE) {
    if (shouldSendAlert('high_error_rate')) {
      sendAlert(
        SEVERITY.CRITICAL,
        'HIGH_ERROR_RATE',
        `Taxa de erro está em ${(errorRate * 100).toFixed(2)}% (limite: ${THRESHOLDS.ERROR_RATE * 100}%)`,
        { error_rate: errorRate, total_errors: totalErr, total_requests: total }
      );
    }
  }
}

/**
 * Monitora latência P95
 */
function checkLatency(metrics) {
  if (!metrics || !metrics.latency) return;
  
  for (const [key, stats] of Object.entries(metrics.latency)) {
    if (stats.p95 > THRESHOLDS.LATENCY_P95) {
      if (shouldSendAlert(`high_latency_${key}`)) {
        sendAlert(
          SEVERITY.WARNING,
          'HIGH_LATENCY',
          `Latência P95 de ${key} está em ${stats.p95}ms (limite: ${THRESHOLDS.LATENCY_P95}ms)`,
          { key, p95: stats.p95, p50: stats.p50, p99: stats.p99 }
        );
      }
    }
  }
}

/**
 * Monitora uso de memória
 */
function checkMemoryUsage() {
  const memUsage = process.memoryUsage();
  const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
  
  if (heapUsedMB > THRESHOLDS.MEMORY_USAGE_MB) {
    if (shouldSendAlert('high_memory_usage')) {
      sendAlert(
        SEVERITY.WARNING,
        'HIGH_MEMORY_USAGE',
        `Uso de memória heap está em ${heapUsedMB}MB (limite: ${THRESHOLDS.MEMORY_USAGE_MB}MB)`,
        {
          heap_used_mb: heapUsedMB,
          heap_total_mb: Math.round(memUsage.heapTotal / 1024 / 1024),
          rss_mb: Math.round(memUsage.rss / 1024 / 1024)
        }
      );
    }
  }
}

/**
 * Monitora rate limiting
 */
function checkRateLimiting() {
  try {
    const { getStats } = require('../middleware/rateLimit');
    const stats = getStats();
    
    // Se houver muitas entradas no rate limit store, pode indicar abuso
    if (stats.total > 1000) {
      if (shouldSendAlert('many_rate_limit_entries')) {
        sendAlert(
          SEVERITY.INFO,
          'MANY_RATE_LIMIT_ENTRIES',
          `Rate limit store tem ${stats.total} entradas (possível ataque)`,
          stats
        );
      }
    }
  } catch (err) {
    // Ignore se módulo não disponível
  }
}

/**
 * Monitora tamanho da fila
 */
function checkQueueSize() {
  try {
    const { getQueueMetrics } = require('./queuedSend');
    const queueMetrics = getQueueMetrics();
    
    const totalInQueue = (queueMetrics.by_priority?.START || 0) +
                         (queueMetrics.by_priority?.DISPARO || 0) +
                         (queueMetrics.by_priority?.DOWNSELL || 0);
    
    if (totalInQueue > THRESHOLDS.QUEUE_SIZE) {
      if (shouldSendAlert('large_queue_size')) {
        sendAlert(
          SEVERITY.WARNING,
          'LARGE_QUEUE_SIZE',
          `Fila de mensagens tem ${totalInQueue} items (limite: ${THRESHOLDS.QUEUE_SIZE})`,
          { queue_size: totalInQueue, by_priority: queueMetrics.by_priority }
        );
      }
    }
  } catch (err) {
    // Ignore se módulo não disponível
  }
}

/**
 * Monitora latência do database
 */
async function checkDatabaseHealth(pool) {
  if (!pool) return;
  
  try {
    const start = Date.now();
    await pool.query('SELECT 1');
    const latency = Date.now() - start;
    
    if (latency > THRESHOLDS.DATABASE_LATENCY_MS) {
      if (shouldSendAlert('slow_database')) {
        sendAlert(
          SEVERITY.WARNING,
          'SLOW_DATABASE',
          `Database latency está em ${latency}ms (limite: ${THRESHOLDS.DATABASE_LATENCY_MS}ms)`,
          { latency_ms: latency }
        );
      }
    }
  } catch (err) {
    if (shouldSendAlert('database_error')) {
      sendAlert(
        SEVERITY.CRITICAL,
        'DATABASE_ERROR',
        `Erro ao conectar com database: ${err.message}`,
        { error: err.message }
      );
    }
  }
}

/**
 * Executa todos os checks de monitoramento
 */
async function runHealthChecks(pool) {
  try {
    // Obter métricas
    const { getMetrics } = require('./sendService');
    const metrics = getMetrics();
    
    // Executar checks
    checkErrorRate(metrics);
    checkLatency(metrics);
    checkMemoryUsage();
    checkRateLimiting();
    checkQueueSize();
    await checkDatabaseHealth(pool);
    
  } catch (err) {
    console.error('[ALERTING][RUN_CHECKS][ERR]', { error: err.message });
  }
}

/**
 * Inicia monitoramento periódico
 */
function startMonitoring(pool, intervalMinutes = 5) {
  const intervalMs = intervalMinutes * 60 * 1000;
  
  console.info('[ALERTING] Monitoramento iniciado', {
    interval_minutes: intervalMinutes,
    thresholds: THRESHOLDS
  });
  
  // Check inicial
  runHealthChecks(pool);
  
  // Checks periódicos
  const interval = setInterval(() => {
    runHealthChecks(pool);
  }, intervalMs);
  
  // Permitir que processo termine
  interval.unref();
  
  return () => clearInterval(interval);
}

/**
 * Obtém estatísticas de alertas
 */
function getAlertStats() {
  const now = Date.now();
  const recentAlerts = [];
  
  for (const [type, timestamp] of alertHistory.entries()) {
    const ageMs = now - timestamp;
    if (ageMs < 60 * 60 * 1000) { // Últimas 1h
      recentAlerts.push({
        type,
        last_sent: new Date(timestamp).toISOString(),
        age_minutes: Math.round(ageMs / 60 / 1000)
      });
    }
  }
  
  return {
    total_alert_types: alertHistory.size,
    recent_alerts_1h: recentAlerts,
    cooldown_minutes: ALERT_COOLDOWN_MS / 60 / 1000
  };
}

module.exports = {
  startMonitoring,
  runHealthChecks,
  sendAlert,
  getAlertStats,
  SEVERITY,
  THRESHOLDS
};
