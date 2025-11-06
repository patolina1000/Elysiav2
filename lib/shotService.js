/**
 * Serviço de disparo/broadcast
 * Gerencia criação e envio de mensagens em massa
 */

const { observe } = require('./metricsService');

/**
 * Lista disparos de um bot
 * @param {object} pool - Pool PostgreSQL
 * @param {string} slug - Slug do bot
 * @returns {Promise<Array>}
 */
async function listShots(pool, slug) {
  if (!pool) throw new Error('DATABASE_NOT_AVAILABLE');
  if (!slug) throw new Error('MISSING_SLUG');
  
  const query = `
    SELECT id, slug, title, content, target, status, 
           total_targets, sent_count, failed_count,
           created_at, updated_at, started_at, completed_at
    FROM public.shots
    WHERE slug = $1
    ORDER BY created_at DESC
  `;
  
  const result = await pool.query(query, [slug]);
  return result.rows;
}

/**
 * Obtém detalhes de um disparo
 * @param {object} pool - Pool PostgreSQL
 * @param {number} shotId - ID do disparo
 * @returns {Promise<object>}
 */
async function getShot(pool, shotId) {
  if (!pool) throw new Error('DATABASE_NOT_AVAILABLE');
  if (!shotId) throw new Error('MISSING_SHOT_ID');
  
  const query = `
    SELECT id, slug, title, content, target, status, 
           total_targets, sent_count, failed_count,
           created_at, updated_at, started_at, completed_at
    FROM public.shots
    WHERE id = $1
  `;
  
  const result = await pool.query(query, [shotId]);
  
  if (result.rowCount === 0) {
    throw new Error('SHOT_NOT_FOUND');
  }
  
  return result.rows[0];
}

/**
 * Cria um novo disparo
 * @param {object} pool - Pool PostgreSQL
 * @param {object} params - { slug, title, content, target }
 * @returns {Promise<object>}
 */
async function createShot(pool, params) {
  if (!pool) throw new Error('DATABASE_NOT_AVAILABLE');
  
  const { slug, title, content, target = 'all_started' } = params;
  
  if (!slug) throw new Error('MISSING_SLUG');
  if (!title) throw new Error('MISSING_TITLE');
  if (!content) throw new Error('MISSING_CONTENT');
  
  const contentObj = typeof content === 'string' ? JSON.parse(content) : content;
  
  const query = `
    INSERT INTO public.shots (slug, title, content, target, status, created_at, updated_at)
    VALUES ($1, $2, $3, $4, 'DRAFT', now(), now())
    RETURNING id, slug, title, content, target, status, total_targets, sent_count, failed_count, created_at
  `;
  
  const result = await pool.query(query, [
    slug,
    title,
    JSON.stringify(contentObj),
    target
  ]);
  
  console.info('[SHOT][CREATED]', { shot_id: result.rows[0].id, slug, title, target });
  
  return result.rows[0];
}

/**
 * Popula a fila de um disparo com os alvos
 * @param {object} pool - Pool PostgreSQL
 * @param {number} shotId - ID do disparo
 * @returns {Promise<number>} Quantidade de alvos enfileirados
 */
async function populateShotQueue(pool, shotId) {
  if (!pool) throw new Error('DATABASE_NOT_AVAILABLE');
  if (!shotId) throw new Error('MISSING_SHOT_ID');
  
  // Buscar configuração do disparo
  const shot = await getShot(pool, shotId);
  
  let targetQuery = '';
  
  switch (shot.target) {
    case 'all_started':
      // Todos que já deram /start
      targetQuery = `
        INSERT INTO public.shots_queue (shot_id, slug, tg_id, status, created_at, updated_at)
        SELECT $1, $2, tg_id, 'PENDING', now(), now()
        FROM public.funnel_events
        WHERE slug = $2 AND event_type = 'start'
        GROUP BY tg_id
        ON CONFLICT DO NOTHING
      `;
      break;
      
    case 'after_pix':
      // Todos que geraram PIX
      targetQuery = `
        INSERT INTO public.shots_queue (shot_id, slug, tg_id, status, created_at, updated_at)
        SELECT $1, $2, tg_id, 'PENDING', now(), now()
        FROM public.funnel_events
        WHERE slug = $2 AND event_type = 'pix_generated'
        GROUP BY tg_id
        ON CONFLICT DO NOTHING
      `;
      break;
      
    default:
      throw new Error('INVALID_TARGET');
  }
  
  const result = await pool.query(targetQuery, [shotId, shot.slug]);
  const count = result.rowCount;
  
  // Atualizar total_targets e status
  await pool.query(`
    UPDATE public.shots
    SET total_targets = $1, status = 'QUEUED', updated_at = now()
    WHERE id = $2
  `, [count, shotId]);
  
  console.info('[SHOT][QUEUE_POPULATED]', { shot_id: shotId, slug: shot.slug, count });
  observe('shot_queue_populated', count, { bot: shot.slug });
  
  return count;
}

/**
 * Busca próximos alvos pendentes de um disparo
 * @param {object} pool - Pool PostgreSQL
 * @param {number} shotId - ID do disparo
 * @param {number} limit - Limite de registros
 * @returns {Promise<Array>}
 */
async function getPendingShotTargets(pool, shotId, limit = 50) {
  if (!pool) throw new Error('DATABASE_NOT_AVAILABLE');
  if (!shotId) throw new Error('MISSING_SHOT_ID');
  
  const query = `
    SELECT sq.id, sq.shot_id, sq.slug, sq.tg_id, sq.attempts,
           s.content
    FROM public.shots_queue sq
    JOIN public.shots s ON s.id = sq.shot_id
    WHERE sq.shot_id = $1 AND sq.status = 'PENDING'
    ORDER BY sq.id ASC
    LIMIT $2
  `;
  
  const result = await pool.query(query, [shotId, limit]);
  return result.rows;
}

/**
 * Marca alvo como enviado
 * @param {object} pool - Pool PostgreSQL
 * @param {number} queueId - ID na fila
 * @returns {Promise<boolean>}
 */
async function markShotTargetSent(pool, queueId) {
  if (!pool) throw new Error('DATABASE_NOT_AVAILABLE');
  if (!queueId) throw new Error('MISSING_QUEUE_ID');
  
  const query = `
    UPDATE public.shots_queue
    SET status = 'SENT', updated_at = now(), last_attempt_at = now()
    WHERE id = $1
    RETURNING shot_id
  `;
  
  const result = await pool.query(query, [queueId]);
  
  if (result.rowCount > 0) {
    // Incrementar contador de enviados
    await pool.query(`
      UPDATE public.shots
      SET sent_count = sent_count + 1, updated_at = now()
      WHERE id = $1
    `, [result.rows[0].shot_id]);
  }
  
  return result.rowCount > 0;
}

/**
 * Marca alvo como falho
 * @param {object} pool - Pool PostgreSQL
 * @param {number} queueId - ID na fila
 * @param {string} errorMessage - Mensagem de erro
 * @returns {Promise<boolean>}
 */
async function markShotTargetFailed(pool, queueId, errorMessage) {
  if (!pool) throw new Error('DATABASE_NOT_AVAILABLE');
  if (!queueId) throw new Error('MISSING_QUEUE_ID');
  
  const query = `
    UPDATE public.shots_queue
    SET status = 'FAILED',
        attempts = attempts + 1,
        error_message = $2,
        updated_at = now(),
        last_attempt_at = now()
    WHERE id = $1
    RETURNING shot_id
  `;
  
  const result = await pool.query(query, [queueId, errorMessage]);
  
  if (result.rowCount > 0) {
    // Incrementar contador de falhas
    await pool.query(`
      UPDATE public.shots
      SET failed_count = failed_count + 1, updated_at = now()
      WHERE id = $1
    `, [result.rows[0].shot_id]);
  }
  
  return result.rowCount > 0;
}

/**
 * Inicia um disparo (muda status para SENDING)
 * @param {object} pool - Pool PostgreSQL
 * @param {number} shotId - ID do disparo
 * @returns {Promise<boolean>}
 */
async function startShot(pool, shotId) {
  if (!pool) throw new Error('DATABASE_NOT_AVAILABLE');
  if (!shotId) throw new Error('MISSING_SHOT_ID');
  
  const query = `
    UPDATE public.shots
    SET status = 'SENDING', started_at = now(), updated_at = now()
    WHERE id = $1 AND status IN ('QUEUED', 'PAUSED')
    RETURNING id, slug
  `;
  
  const result = await pool.query(query, [shotId]);
  
  if (result.rowCount > 0) {
    console.info('[SHOT][STARTED]', { shot_id: shotId, slug: result.rows[0].slug });
  }
  
  return result.rowCount > 0;
}

/**
 * Pausa um disparo
 * @param {object} pool - Pool PostgreSQL
 * @param {number} shotId - ID do disparo
 * @returns {Promise<boolean>}
 */
async function pauseShot(pool, shotId) {
  if (!pool) throw new Error('DATABASE_NOT_AVAILABLE');
  if (!shotId) throw new Error('MISSING_SHOT_ID');
  
  const query = `
    UPDATE public.shots
    SET status = 'PAUSED', updated_at = now()
    WHERE id = $1 AND status = 'SENDING'
    RETURNING id, slug
  `;
  
  const result = await pool.query(query, [shotId]);
  
  if (result.rowCount > 0) {
    console.info('[SHOT][PAUSED]', { shot_id: shotId, slug: result.rows[0].slug });
  }
  
  return result.rowCount > 0;
}

/**
 * Cancela um disparo
 * @param {object} pool - Pool PostgreSQL
 * @param {number} shotId - ID do disparo
 * @returns {Promise<boolean>}
 */
async function cancelShot(pool, shotId) {
  if (!pool) throw new Error('DATABASE_NOT_AVAILABLE');
  if (!shotId) throw new Error('MISSING_SHOT_ID');
  
  const query = `
    UPDATE public.shots
    SET status = 'CANCELED', updated_at = now()
    WHERE id = $1 AND status IN ('DRAFT', 'QUEUED', 'SENDING', 'PAUSED')
    RETURNING id, slug
  `;
  
  const result = await pool.query(query, [shotId]);
  
  if (result.rowCount > 0) {
    // Marcar todos pendentes como SKIPPED
    await pool.query(`
      UPDATE public.shots_queue
      SET status = 'SKIPPED', updated_at = now()
      WHERE shot_id = $1 AND status = 'PENDING'
    `, [shotId]);
    
    console.info('[SHOT][CANCELED]', { shot_id: shotId, slug: result.rows[0].slug });
  }
  
  return result.rowCount > 0;
}

/**
 * Marca disparo como completo (quando todos foram processados)
 * @param {object} pool - Pool PostgreSQL
 * @param {number} shotId - ID do disparo
 * @returns {Promise<boolean>}
 */
async function completeShot(pool, shotId) {
  if (!pool) throw new Error('DATABASE_NOT_AVAILABLE');
  if (!shotId) throw new Error('MISSING_SHOT_ID');
  
  const query = `
    UPDATE public.shots
    SET status = 'COMPLETED', completed_at = now(), updated_at = now()
    WHERE id = $1 AND status = 'SENDING'
    RETURNING id, slug
  `;
  
  const result = await pool.query(query, [shotId]);
  
  if (result.rowCount > 0) {
    console.info('[SHOT][COMPLETED]', { shot_id: shotId, slug: result.rows[0].slug });
  }
  
  return result.rowCount > 0;
}

/**
 * Verifica se um disparo foi completado
 * @param {object} pool - Pool PostgreSQL
 * @param {number} shotId - ID do disparo
 * @returns {Promise<boolean>}
 */
async function isShotComplete(pool, shotId) {
  if (!pool) throw new Error('DATABASE_NOT_AVAILABLE');
  if (!shotId) throw new Error('MISSING_SHOT_ID');
  
  const query = `
    SELECT COUNT(*) as pending_count
    FROM public.shots_queue
    WHERE shot_id = $1 AND status = 'PENDING'
  `;
  
  const result = await pool.query(query, [shotId]);
  const pendingCount = parseInt(result.rows[0].pending_count, 10);
  
  return pendingCount === 0;
}

module.exports = {
  listShots,
  getShot,
  createShot,
  populateShotQueue,
  getPendingShotTargets,
  markShotTargetSent,
  markShotTargetFailed,
  startShot,
  pauseShot,
  cancelShot,
  completeShot,
  isShotComplete
};
