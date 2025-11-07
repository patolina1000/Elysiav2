/**
 * Worker de disparo/broadcast
 * Processa fila de disparos ativos e envia via queuedSend
 */

const config = require('../config/rate');
const { 
  getPendingShotTargets, 
  markShotTargetSent, 
  markShotTargetFailed,
  isShotComplete,
  completeShot
} = require('./shotService');
const { sendMessage } = require('./queuedSend');
const { observe } = require('./metricsService');

let isRunning = false;
let workerInterval = null;
let activeShotIds = new Set(); // Disparos ativos sendo processados

/**
 * Processa um lote de alvos de um disparo
 * @param {object} pool - Pool PostgreSQL
 * @param {number} shotId - ID do disparo
 * @param {number} batchSize - Tamanho do lote
 */
async function processShotBatch(pool, shotId, batchSize = 30) {
  if (!pool || !shotId) return;
  
  try {
    const targets = await getPendingShotTargets(pool, shotId, batchSize);
    
    if (targets.length === 0) {
      // Verificar se o disparo foi completado
      const isComplete = await isShotComplete(pool, shotId);
      if (isComplete) {
        await completeShot(pool, shotId);
        activeShotIds.delete(shotId);
        console.info('[SHOT_WORKER][COMPLETED]', { shot_id: shotId });
      }
      return;
    }
    
    console.info('[SHOT_WORKER] Processando lote:', { shot_id: shotId, count: targets.length });
    
    for (const target of targets) {
      try {
        const content = typeof target.content === 'string' 
          ? JSON.parse(target.content) 
          : target.content;
        
        // Enviar via fila com prioridade DISPARO
        const result = await sendMessage(pool, {
          slug: target.slug,
          chat_id: target.tg_id,
          text: content.text || '',
          parse_mode: content.parse_mode || 'MarkdownV2',
          disable_web_page_preview: content.disable_web_page_preview !== false,
          purpose: 'disparo',
          shot_id: target.shot_id,
          raw: content.raw || false
        });
        
        if (result.ok) {
          await markShotTargetSent(pool, target.id);
          observe('shot_sent', 1, { bot: target.slug });
          
          console.info('[SHOT_WORKER][SENT]', {
            queue_id: target.id,
            shot_id: target.shot_id,
            slug: target.slug,
            tg_id: target.tg_id,
            lat_ms: result.lat_ms
          });
        } else {
          await markShotTargetFailed(pool, target.id, result.error || 'SEND_FAILED');
          observe('shot_failed', 1, { bot: target.slug });
          
          console.error('[SHOT_WORKER][FAILED]', {
            queue_id: target.id,
            shot_id: target.shot_id,
            slug: target.slug,
            tg_id: target.tg_id,
            error: result.error
          });
        }
        
        // Delay entre envios para respeitar rate limit global
        await new Promise(resolve => setTimeout(resolve, 100));
        
      } catch (err) {
        console.error('[SHOT_WORKER][TARGET_ERR]', {
          queue_id: target.id,
          shot_id: target.shot_id,
          error: err.message
        });
        
        await markShotTargetFailed(pool, target.id, err.message).catch(() => {});
      }
    }
    
  } catch (err) {
    console.error('[SHOT_WORKER][BATCH_ERR]', { shot_id: shotId, error: err.message });
  }
}

/**
 * Busca disparos ativos (status SENDING) e processa
 * @param {object} pool - Pool PostgreSQL
 */
async function processActiveShots(pool) {
  if (!pool) return;
  
  try {
    // Buscar disparos com status SENDING
    const query = `
      SELECT id, slug, title
      FROM public.shots
      WHERE status = 'SENDING'
      ORDER BY started_at ASC
      LIMIT 10
    `;
    
    const result = await pool.query(query);
    
    if (result.rows.length === 0) {
      return;
    }
    
    console.info('[SHOT_WORKER] Disparos ativos:', { count: result.rows.length });
    
    // Processar cada disparo ativo
    for (const shot of result.rows) {
      activeShotIds.add(shot.id);
      
      // Processar lote deste disparo (não bloqueia)
      processShotBatch(pool, shot.id, 30).catch(err => {
        console.error('[SHOT_WORKER][SHOT_ERR]', { 
          shot_id: shot.id, 
          error: err.message 
        });
      });
      
      // Delay entre disparos diferentes
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    
  } catch (err) {
    console.error('[SHOT_WORKER][ACTIVE_ERR]', { error: err.message });
  }
}

/**
 * Inicia o worker de disparo
 * @param {object} pool - Pool PostgreSQL
 * @param {number} intervalMs - Intervalo entre processamentos (padrão: 5s)
 */
function start(pool, intervalMs = 5000) {
  if (isRunning) {
    console.warn('[SHOT_WORKER] Já está rodando');
    return;
  }
  
  if (!pool) {
    console.warn('[SHOT_WORKER] Pool não disponível, worker não iniciado');
    return;
  }
  
  isRunning = true;
  
  console.info('[SHOT_WORKER] Iniciando...', { interval_ms: intervalMs });
  
  // Processar imediatamente
  processActiveShots(pool).catch(err => {
    console.error('[SHOT_WORKER][INIT_ERR]', { error: err.message });
  });
  
  // Processar periodicamente
  workerInterval = setInterval(() => {
    processActiveShots(pool).catch(err => {
      console.error('[SHOT_WORKER][INTERVAL_ERR]', { error: err.message });
    });
  }, intervalMs);
  
  console.info('[SHOT_WORKER] Iniciado com sucesso');
}

/**
 * Para o worker de disparo
 */
function stop() {
  if (!isRunning) {
    return;
  }
  
  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = null;
  }
  
  isRunning = false;
  activeShotIds.clear();
  console.info('[SHOT_WORKER] Parado');
}

/**
 * Verifica se o worker está rodando
 * @returns {object}
 */
function getStatus() {
  return {
    running: isRunning,
    interval_ms: workerInterval ? 5000 : null,
    active_shots: Array.from(activeShotIds)
  };
}

module.exports = {
  start,
  stop,
  getStatus
};
