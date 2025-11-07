/**
 * Worker de downsell agendado
 * Processa fila de downsells pendentes e envia via queuedSend
 */

const config = require('../config/rate');
const { getPendingDownsells, markDownsellSent, markDownsellFailed, markDownsellSkipped } = require('./downsellService');
const { checkDownsellEligibility } = require('./pixEligibilityService');
const { sendMessage } = require('./queuedSend');
const { observe } = require('./metricsService');

let isRunning = false;
let workerInterval = null;

/**
 * Processa um lote de downsells pendentes
 * @param {object} pool - Pool PostgreSQL
 */
async function processBatch(pool) {
  if (!pool) return;
  
  try {
    const pending = await getPendingDownsells(pool, 50);
    
    if (pending.length === 0) {
      return;
    }
    
    console.info('[DOWNSELL_WORKER] Processando lote:', { count: pending.length });
    
    for (const item of pending) {
      try {
        // GATING: Double-check de elegibilidade antes de enviar
        const eligibility = await checkDownsellEligibility(pool, {
          trigger: item.trigger,
          transaction_id: item.transaction_id,
          bot_slug: item.bot_slug,
          telegram_id: item.telegram_id
        });
        
        if (!eligibility.eligible) {
          // Não elegível: marcar como skipped
          await markDownsellSkipped(pool, item.id, eligibility.reason || 'not_eligible');
          observe('downsells_skipped_gate', 1, { bot: item.bot_slug });
          
          console.info('[DOWNSELL][SKIP]', {
            queue_id: item.id,
            downsell_id: item.downsell_id,
            bot_slug: item.bot_slug,
            telegram_id: item.telegram_id,
            trigger: item.trigger,
            reason: eligibility.reason
          });
          
          continue;
        }
        
        // Elegível: prosseguir com envio
        const content = typeof item.content === 'string' 
          ? JSON.parse(item.content) 
          : item.content;
        
        let result;
        
        // Verificar se há mídia configurada (novo formato estruturado)
        if (content.media && content.media.file_id && content.media.sha256 && content.media.kind) {
          // Enviar com mídia usando sendMediaMessage
          const { sendMediaMessage } = require('./sendService');
          
          console.info('[DOWNSELL][WITH_MEDIA]', { 
            queue_id: item.id,
            downsell_id: item.downsell_id,
            kind: content.media.kind,
            has_file_id: !!content.media.file_id 
          });
          
          result = await sendMediaMessage(pool, {
            slug: item.bot_slug,
            chat_id: String(item.telegram_id),
            media_sha256: content.media.sha256,
            media_kind: content.media.kind,
            media_r2_key: content.media.r2_key,
            caption: content.caption || content.text || '',
            parse_mode: content.parse_mode || 'MarkdownV2',
            purpose: 'downsell',
            request_id: `downsell_${item.id}`
          });
        } else {
          // Enviar apenas texto via fila com prioridade DOWNSELL
          result = await sendMessage(pool, {
            slug: item.bot_slug,
            chat_id: String(item.telegram_id),
            text: content.text || '',
            parse_mode: content.parse_mode || 'MarkdownV2',
            disable_web_page_preview: content.disable_web_page_preview !== false,
            purpose: 'downsell',
            queue_id: item.id,
            raw: content.raw || false
          });
        }
        
        if (result.ok) {
          await markDownsellSent(pool, item.id, { message_id: result.message_id });
          observe('downsells_sent', 1, { bot: item.bot_slug });
          
          console.info('[DOWNSELL][SEND][OK]', {
            queue_id: item.id,
            downsell_id: item.downsell_id,
            bot_slug: item.bot_slug,
            telegram_id: item.telegram_id,
            trigger: item.trigger,
            message_id: result.message_id,
            lat_ms: result.lat_ms
          });
        } else {
          await markDownsellFailed(pool, item.id, result.error || 'SEND_FAILED');
          observe('downsells_failed', 1, { bot: item.bot_slug });
          
          console.error('[DOWNSELL][SEND][ERR]', {
            queue_id: item.id,
            downsell_id: item.downsell_id,
            bot_slug: item.bot_slug,
            telegram_id: item.telegram_id,
            trigger: item.trigger,
            error: result.error
          });
        }
        
        // Pequeno delay entre envios para respeitar rate limit
        await new Promise(resolve => setTimeout(resolve, 200));
        
      } catch (err) {
        console.error('[DOWNSELL_WORKER][ITEM_ERR]', {
          queue_id: item.id,
          error: err.message
        });
        
        await markDownsellFailed(pool, item.id, err.message).catch(() => {});
      }
    }
    
  } catch (err) {
    console.error('[DOWNSELL_WORKER][BATCH_ERR]', { error: err.message });
  }
}

/**
 * Inicia o worker de downsell
 * @param {object} pool - Pool PostgreSQL
 * @param {number} intervalMs - Intervalo entre processamentos (padrão: 10s)
 */
function start(pool, intervalMs = 10000) {
  if (isRunning) {
    console.warn('[DOWNSELL_WORKER] Já está rodando');
    return;
  }
  
  if (!pool) {
    console.warn('[DOWNSELL_WORKER] Pool não disponível, worker não iniciado');
    return;
  }
  
  isRunning = true;
  
  console.info('[DOWNSELL_WORKER] Iniciando...', { interval_ms: intervalMs });
  
  // Processar imediatamente
  processBatch(pool).catch(err => {
    console.error('[DOWNSELL_WORKER][INIT_ERR]', { error: err.message });
  });
  
  // Processar periodicamente
  workerInterval = setInterval(() => {
    processBatch(pool).catch(err => {
      console.error('[DOWNSELL_WORKER][INTERVAL_ERR]', { error: err.message });
    });
  }, intervalMs);
  
  console.info('[DOWNSELL_WORKER] Iniciado com sucesso');
}

/**
 * Para o worker de downsell
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
  console.info('[DOWNSELL_WORKER] Parado');
}

/**
 * Verifica se o worker está rodando
 * @returns {boolean}
 */
function getStatus() {
  return {
    running: isRunning,
    interval_ms: workerInterval ? 10000 : null
  };
}

module.exports = {
  start,
  stop,
  getStatus
};
