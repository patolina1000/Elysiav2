/**
 * Scheduler de downsells
 * Loop leve que busca downsells prontos e enfileira no queueManager
 */

const { observe } = require('./metricsService');

let isRunning = false;
let schedulerInterval = null;

/**
 * Busca e enfileira downsells prontos para envio
 * @param {object} pool - Pool PostgreSQL
 * @param {object} queueManager - Gerenciador de fila
 */
async function tick(pool, queueManager) {
  if (!pool || !queueManager) return;

  try {
    // Buscar downsells pendentes prontos (scheduled_at <= now)
    const query = `
      SELECT 
        dq.id as queue_id,
        dq.bot_slug,
        dq.telegram_id,
        dq.downsell_id,
        dq.trigger,
        dq.transaction_id,
        dq.event_id
      FROM public.downsells_queue dq
      JOIN public.bot_downsells bd ON bd.id = dq.downsell_id
      WHERE dq.status = 'pending'
        AND dq.scheduled_at <= now()
        AND bd.active = true
      ORDER BY dq.scheduled_at ASC
      LIMIT 50
    `;

    const result = await pool.query(query);
    
    if (result.rows.length === 0) {
      return;
    }

    console.info('[DOWNSELL][DUE]', { batch: result.rows.length });

    // Enfileirar cada downsell no queueManager
    for (const item of result.rows) {
      try {
        await queueManager.enqueue({
          type: 'DOWNSELL',
          priority: 'downsell', // prioridade DOWNSELL (menor que START e SHOT)
          payload: {
            queue_id: item.queue_id,
            bot_slug: item.bot_slug,
            telegram_id: item.telegram_id,
            downsell_id: item.downsell_id,
            trigger: item.trigger,
            transaction_id: item.transaction_id,
            event_id: item.event_id
          }
        });

        observe('downsells_enqueued', 1, { bot: item.bot_slug });
        
        console.info('[DOWNSELL][ENQUEUED]', {
          queue_id: item.queue_id,
          bot_slug: item.bot_slug,
          telegram_id: item.telegram_id,
          trigger: item.trigger
        });
      } catch (err) {
        console.error('[DOWNSELL][ENQUEUE_ERR]', {
          queue_id: item.queue_id,
          error: err.message
        });
      }
    }
  } catch (err) {
    console.error('[DOWNSELL][SCHEDULER][ERR]', { error: err.message });
  }
}

/**
 * Inicia o scheduler de downsells
 * @param {object} pool - Pool PostgreSQL
 * @param {object} queueManager - Gerenciador de fila
 * @param {number} intervalMs - Intervalo entre ticks (padrão: 3000ms = 3s)
 */
function start(pool, queueManager, intervalMs = 3000) {
  if (isRunning) {
    console.warn('[DOWNSELL_SCHEDULER] Já está rodando');
    return;
  }

  if (!pool) {
    console.warn('[DOWNSELL_SCHEDULER] Pool não disponível, scheduler não iniciado');
    return;
  }

  if (!queueManager) {
    console.warn('[DOWNSELL_SCHEDULER] QueueManager não disponível, scheduler não iniciado');
    return;
  }

  isRunning = true;

  console.info('[DOWNSELL_SCHEDULER] Iniciando...', { interval_ms: intervalMs });

  // Tick imediato
  tick(pool, queueManager).catch(err => {
    console.error('[DOWNSELL_SCHEDULER][INIT_ERR]', { error: err.message });
  });

  // Tick periódico
  schedulerInterval = setInterval(() => {
    tick(pool, queueManager).catch(err => {
      console.error('[DOWNSELL_SCHEDULER][TICK_ERR]', { error: err.message });
    });
  }, intervalMs);

  console.info('[DOWNSELL_SCHEDULER] Iniciado com sucesso');
}

/**
 * Para o scheduler de downsells
 */
function stop() {
  if (!isRunning) {
    return;
  }

  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
  }

  isRunning = false;
  console.info('[DOWNSELL_SCHEDULER] Parado');
}

/**
 * Verifica se o scheduler está rodando
 * @returns {boolean}
 */
function getStatus() {
  return {
    running: isRunning,
    interval_ms: schedulerInterval ? 3000 : null
  };
}

module.exports = {
  start,
  stop,
  getStatus,
  tick // exportado para testes
};
