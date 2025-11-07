/**
 * Worker de disparo/broadcast V2
 * Processa fila de disparos ativos, verifica agendamentos e respeita rate limits
 */

const config = require('../config/rate');
const { 
  getDueScheduledShots,
  startShot,
  getPendingShotTargets, 
  markShotTargetSent, 
  markShotTargetFailed,
  markShotTargetSkipped,
  isShotComplete,
  completeShot
} = require('./shotService');
const { sendMessage } = require('./queuedSend');
const { observe } = require('./metricsService');

let isRunning = false;
let workerInterval = null;

/**
 * Verifica e inicia disparos agendados que já devem ser executados
 * @param {object} pool - Pool PostgreSQL
 */
async function processScheduledShots(pool) {
  if (!pool) return;
  
  try {
    const dueShots = await getDueScheduledShots(pool);
    
    if (dueShots.length === 0) return;
    
    console.info('[SHOT_WORKER][SCHEDULED]', { 
      count: dueShots.length 
    });
    
    for (const shot of dueShots) {
      try {
        const count = await startShot(pool, shot.id);
        
        console.info('[SHOT_WORKER][SCHEDULED_STARTED]', {
          shot_id: shot.id,
          slug: shot.bot_slug || shot.slug,
          title: shot.title,
          target_count: count
        });
        
        observe('shot_scheduled_started', 1, { bot: shot.bot_slug || shot.slug });
      } catch (err) {
        console.error('[SHOT_WORKER][SCHEDULED_START_ERR]', {
          shot_id: shot.id,
          error: err.message
        });
      }
    }
  } catch (err) {
    console.error('[SHOT_WORKER][SCHEDULED_ERR]', { error: err.message });
  }
}

/**
 * Processa lote de alvos pendentes de todos os disparos ativos
 * @param {object} pool - Pool PostgreSQL
 */
async function processPendingTargets(pool) {
  if (!pool) return;
  
  try {
    const targets = await getPendingShotTargets(pool, 50);
    
    if (targets.length === 0) return;
    
    console.info('[SHOT_WORKER] Processando lote:', { count: targets.length });
    
    for (const target of targets) {
      try {
        // Parse do conteúdo da mensagem
        const message = typeof target.message === 'string' 
          ? JSON.parse(target.message) 
          : target.message;
        
        // Verificar se há mídias configuradas (novo sistema multi-media)
        let mediaRefs = target.media_refs || [];
        if (typeof mediaRefs === 'string') {
          mediaRefs = JSON.parse(mediaRefs);
        }
        if (!Array.isArray(mediaRefs)) {
          mediaRefs = [];
        }
        
        console.info('[SHOT][MEDIA_CHECK]', {
          queue_id: target.id,
          has_media_refs: !!target.media_refs,
          media_refs_type: typeof target.media_refs,
          parsed_count: mediaRefs.length
        });
        
        if (!message || !message.text) {
          await markShotTargetSkipped(pool, target.id, 'missing_message_text');
          console.warn('[SHOT_WORKER][SKIP]', {
            queue_id: target.id,
            reason: 'missing_message_text'
          });
          continue;
        }
        
        let result;
        
        if (mediaRefs.length > 0) {
          // Enviar múltiplas mídias primeiro (separadas, sem caption)
          const { sendMultipleMedias } = require('./multiMediaSendService');
          
          console.info('[SHOT][WITH_MULTI_MEDIA]', { 
            queue_id: target.id,
            shot_id: target.shot_id,
            media_count: mediaRefs.length,
            kinds: mediaRefs.map(m => m.kind).join(',')
          });
          
          const mediaResult = await sendMultipleMedias(pool, {
            slug: target.bot_slug,
            chat_id: String(target.telegram_id),
            media_refs: mediaRefs,
            purpose: 'shot'
          });
          
          // Depois enviar texto separado
          if (mediaResult.ok) {
            result = await sendMessage(pool, {
              slug: target.bot_slug,
              chat_id: String(target.telegram_id),
              text: message.text,
              parse_mode: message.parse_mode || 'MarkdownV2',
              disable_web_page_preview: message.disable_web_page_preview !== false,
              purpose: 'shot',
              queue_id: target.id,
              shot_id: target.shot_id,
              raw: message.raw || false
            });
          } else {
            // Falha nas mídias, mas ainda tentar enviar texto
            console.warn('[SHOT][MEDIA_FAILED]', {
              queue_id: target.id,
              shot_id: target.shot_id,
              errors: mediaResult.summary.errors
            });
            
            result = await sendMessage(pool, {
              slug: target.bot_slug,
              chat_id: String(target.telegram_id),
              text: message.text,
              parse_mode: message.parse_mode || 'MarkdownV2',
              disable_web_page_preview: message.disable_web_page_preview !== false,
              purpose: 'shot',
              queue_id: target.id,
              shot_id: target.shot_id,
              raw: message.raw || false
            });
          }
        } else {
          // Enviar via fila com prioridade SHOT (texto apenas)
          result = await sendMessage(pool, {
            slug: target.bot_slug || target.slug,
            chat_id: String(target.telegram_id || target.tg_id),
            text: message.text || '',
            file_id: message.file_id,
            caption: message.caption,
            parse_mode: target.parse_mode || 'MarkdownV2',
            disable_web_page_preview: message.disable_web_page_preview !== false,
            purpose: 'shot',
            queue_id: target.id,
            raw: message.raw || false
          });
        }
        
        if (result.ok) {
          await markShotTargetSent(pool, target.id, { message_id: result.message_id });
          observe('shot_sent', 1, { bot: target.bot_slug || target.slug });
          
          console.info('[SHOT][SEND][OK]', {
            queue_id: target.id,
            shot_id: target.shot_id,
            slug: target.bot_slug || target.slug,
            telegram_id: target.telegram_id,
            message_id: result.message_id,
            lat_ms: result.lat_ms
          });
        } else {
          // Verificar se é erro de usuário bloqueado
          const errorStr = result.error || '';
          if (errorStr.includes('bot was blocked') || 
              errorStr.includes('user is deactivated') ||
              errorStr.includes('chat not found')) {
            await markShotTargetSkipped(pool, target.id, result.error);
            observe('shot_skipped_blocked', 1, { bot: target.bot_slug || target.slug });
            
            console.warn('[SHOT][SKIP][BLOCKED]', {
              queue_id: target.id,
              shot_id: target.shot_id,
              telegram_id: target.telegram_id,
              reason: result.error
            });
          } else {
            await markShotTargetFailed(pool, target.id, result.error);
            observe('shot_failed', 1, { bot: target.bot_slug || target.slug });
            
            console.error('[SHOT][SEND][ERR]', {
              queue_id: target.id,
              shot_id: target.shot_id,
              telegram_id: target.telegram_id,
              error: result.error
            });
          }
        }
        
        // Pequeno delay entre envios para respeitar rate limit
        await new Promise(resolve => setTimeout(resolve, 100));
        
      } catch (err) {
        console.error('[SHOT_WORKER][TARGET_ERR]', {
          queue_id: target.id,
          error: err.message
        });
        
        await markShotTargetFailed(pool, target.id, err.message);
      }
    }
    
    // Verificar disparos completados
    await checkCompletedShots(pool);
    
  } catch (err) {
    console.error('[SHOT_WORKER][ERR]', { error: err.message });
  }
}

/**
 * Verifica e marca disparos como completados
 * @param {object} pool - Pool PostgreSQL
 */
async function checkCompletedShots(pool) {
  if (!pool) return;
  
  try {
    const query = `
      SELECT DISTINCT s.id, s.slug, s.bot_slug
      FROM public.shots s
      WHERE s.status = 'sending'
        AND NOT EXISTS (
          SELECT 1 FROM public.shots_queue sq
          WHERE sq.shot_id = s.id AND sq.status = 'PENDING'
        )
    `;
    
    const result = await pool.query(query);
    
    for (const shot of result.rows) {
      await completeShot(pool, shot.id);
      
      console.info('[SHOT_WORKER][AUTO_COMPLETED]', {
        shot_id: shot.id,
        slug: shot.bot_slug || shot.slug
      });
    }
  } catch (err) {
    console.error('[SHOT_WORKER][CHECK_COMPLETED_ERR]', { error: err.message });
  }
}

/**
 * Tick do worker (executa periodicamente)
 * @param {object} pool - Pool PostgreSQL
 */
async function tick(pool) {
  if (!pool || !isRunning) return;
  
  try {
    // 1. Processar disparos agendados que já venceram
    await processScheduledShots(pool);
    
    // 2. Processar alvos pendentes de disparos ativos
    await processPendingTargets(pool);
    
  } catch (err) {
    console.error('[SHOT_WORKER][TICK_ERR]', { error: err.message });
  }
}

/**
 * Inicia o worker de disparos
 * @param {object} pool - Pool PostgreSQL
 * @param {number} intervalMs - Intervalo entre ticks (padrão: 5000ms = 5s)
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
  
  // Executar primeiro tick imediatamente
  tick(pool).catch(err => {
    console.error('[SHOT_WORKER][INIT_ERR]', { error: err.message });
  });
  
  // Agendar ticks periódicos
  workerInterval = setInterval(() => {
    tick(pool).catch(err => {
      console.error('[SHOT_WORKER][INTERVAL_ERR]', { error: err.message });
    });
  }, intervalMs);
  
  console.info('[SHOT_WORKER] Iniciado com sucesso');
}

/**
 * Para o worker de disparos
 */
function stop() {
  if (!isRunning) {
    console.warn('[SHOT_WORKER] Não está rodando');
    return;
  }

  isRunning = false;
  
  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = null;
  }
  
  console.info('[SHOT_WORKER] Parado');
}

module.exports = {
  start,
  stop,
  tick
};
