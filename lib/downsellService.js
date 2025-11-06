/**
 * Serviço de downsell agendado
 * Gerencia configurações de downsell e fila de envios agendados
 */

const { observe } = require('./metricsService');
const { hasUnpaidPix } = require('./pixEligibilityService');

/**
 * Lista downsells configurados para um bot
 * @param {object} pool - Pool PostgreSQL
 * @param {string} slug - Slug do bot
 * @returns {Promise<Array>}
 */
async function listDownsells(pool, slug) {
  if (!pool) throw new Error('DATABASE_NOT_AVAILABLE');
  if (!slug) throw new Error('MISSING_SLUG');
  
  const query = `
    SELECT id, slug, name, content, delay_seconds, delay_minutes, 
           active, after_start, after_pix, created_at, updated_at
    FROM public.bot_downsells
    WHERE slug = $1
    ORDER BY created_at DESC
  `;
  
  const result = await pool.query(query, [slug]);
  return result.rows;
}

/**
 * Cria um novo downsell
 * @param {object} pool - Pool PostgreSQL
 * @param {object} params - { slug, name, content, delay_seconds, active }
 * @returns {Promise<object>}
 */
async function createDownsell(pool, params) {
  if (!pool) throw new Error('DATABASE_NOT_AVAILABLE');
  
  const { 
    slug, name, content, 
    delay_seconds, delay_minutes = 20, 
    active = true, 
    after_start = true, 
    after_pix = false 
  } = params;
  
  if (!slug) throw new Error('MISSING_SLUG');
  if (!name) throw new Error('MISSING_NAME');
  if (!content) throw new Error('MISSING_CONTENT');
  
  const contentObj = typeof content === 'string' ? JSON.parse(content) : content;
  
  const query = `
    INSERT INTO public.bot_downsells (
      slug, name, content, delay_seconds, delay_minutes, 
      active, after_start, after_pix, created_at, updated_at
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now(), now())
    RETURNING id, slug, name, content, delay_seconds, delay_minutes, 
              active, after_start, after_pix, created_at, updated_at
  `;
  
  const result = await pool.query(query, [
    slug,
    name,
    JSON.stringify(contentObj),
    delay_seconds || (delay_minutes * 60),
    delay_minutes,
    active,
    after_start,
    after_pix
  ]);
  
  return result.rows[0];
}

/**
 * Atualiza um downsell existente
 * @param {object} pool - Pool PostgreSQL
 * @param {number} id - ID do downsell
 * @param {object} params - { name, content, delay_seconds, active }
 * @returns {Promise<object>}
 */
async function updateDownsell(pool, id, params) {
  if (!pool) throw new Error('DATABASE_NOT_AVAILABLE');
  if (!id) throw new Error('MISSING_ID');
  
  const { name, content, delay_seconds, delay_minutes, active, after_start, after_pix } = params;
  const updates = [];
  const values = [];
  let paramIndex = 1;
  
  if (name !== undefined) {
    updates.push(`name = $${paramIndex++}`);
    values.push(name);
  }
  
  if (content !== undefined) {
    const contentObj = typeof content === 'string' ? JSON.parse(content) : content;
    updates.push(`content = $${paramIndex++}`);
    values.push(JSON.stringify(contentObj));
  }
  
  if (delay_minutes !== undefined) {
    updates.push(`delay_minutes = $${paramIndex++}`);
    values.push(delay_minutes);
    // Atualizar delay_seconds também para compatibilidade
    updates.push(`delay_seconds = $${paramIndex++}`);
    values.push(delay_minutes * 60);
  } else if (delay_seconds !== undefined) {
    updates.push(`delay_seconds = $${paramIndex++}`);
    values.push(delay_seconds);
  }
  
  if (active !== undefined) {
    updates.push(`active = $${paramIndex++}`);
    values.push(active);
  }
  
  if (after_start !== undefined) {
    updates.push(`after_start = $${paramIndex++}`);
    values.push(after_start);
  }
  
  if (after_pix !== undefined) {
    updates.push(`after_pix = $${paramIndex++}`);
    values.push(after_pix);
  }
  
  updates.push(`updated_at = now()`);
  values.push(id);
  
  const query = `
    UPDATE public.bot_downsells
    SET ${updates.join(', ')}
    WHERE id = $${paramIndex}
    RETURNING id, slug, name, content, delay_seconds, delay_minutes, 
              active, after_start, after_pix, created_at, updated_at
  `;
  
  const result = await pool.query(query, values);
  
  if (result.rowCount === 0) {
    throw new Error('DOWNSELL_NOT_FOUND');
  }
  
  return result.rows[0];
}

/**
 * Deleta um downsell
 * @param {object} pool - Pool PostgreSQL
 * @param {number} id - ID do downsell
 * @returns {Promise<boolean>}
 */
async function deleteDownsell(pool, id) {
  if (!pool) throw new Error('DATABASE_NOT_AVAILABLE');
  if (!id) throw new Error('MISSING_ID');
  
  const query = `DELETE FROM public.bot_downsells WHERE id = $1`;
  const result = await pool.query(query, [id]);
  
  return result.rowCount > 0;
}

/**
 * Agenda downsells para o gatilho /start
 * @param {object} pool - Pool PostgreSQL
 * @param {object} params - { bot_slug, telegram_id, correlation_id, now }
 * @returns {Promise<number>} Quantidade agendada
 */
async function scheduleDownsellsForStart(pool, params) {
  if (!pool) throw new Error('DATABASE_NOT_AVAILABLE');
  
  const { bot_slug, telegram_id, correlation_id, now = new Date(), downsell_id_filter } = params;
  
  if (!bot_slug) throw new Error('MISSING_BOT_SLUG');
  if (!telegram_id) throw new Error('MISSING_TELEGRAM_ID');
  
  try {
    // Buscar downsells ativos com after_start=true
    let query = `
      SELECT id, delay_minutes
      FROM public.bot_downsells
      WHERE slug = $1 AND active = true AND after_start = true
    `;
    
    const queryParams = [bot_slug];
    
    // Filtro opcional para testes
    if (downsell_id_filter) {
      query += ` AND id = $2`;
      queryParams.push(downsell_id_filter);
    }
    
    const result = await pool.query(query, queryParams);
    let scheduled = 0;
    
    for (const downsell of result.rows) {
      const scheduled_at = new Date(now.getTime() + (downsell.delay_minutes * 60 * 1000));
      const event_id = `dw:${bot_slug}:${telegram_id}:${downsell.id}:st:${scheduled_at.toISOString()}`;
      
      const insertQuery = `
        INSERT INTO public.downsells_queue (
          bot_slug, telegram_id, downsell_id, transaction_id, trigger,
          scheduled_at, status, meta, event_id, created_at, updated_at
        )
        VALUES ($1, $2, $3, NULL, 'start', $4, 'pending', $5, $6, now(), now())
        ON CONFLICT (event_id) DO NOTHING
      `;
      
      const meta = { correlation_id, scheduled_by: 'start_trigger' };
      const insertResult = await pool.query(insertQuery, [
        bot_slug,
        telegram_id,
        downsell.id,
        scheduled_at,
        JSON.stringify(meta),
        event_id
      ]);
      
      if (insertResult.rowCount > 0) {
        scheduled++;
        observe('downsells_scheduled_start', 1, { bot: bot_slug });
        console.info('[DOWNSELL][SCHEDULED][START]', {
          bot_slug,
          telegram_id,
          downsell_id: downsell.id,
          scheduled_at: scheduled_at.toISOString(),
          event_id
        });
      }
    }
    
    return scheduled;
  } catch (err) {
    console.error('[DOWNSELL][SCHEDULE_START][ERR]', {
      bot_slug,
      telegram_id,
      error: err.message
    });
    throw err;
  }
}

/**
 * Agenda downsells para o gatilho PIX criado
 * @param {object} pool - Pool PostgreSQL
 * @param {object} params - { bot_slug, telegram_id, transaction_id, correlation_id, now }
 * @returns {Promise<number>} Quantidade agendada
 */
async function scheduleDownsellsForPix(pool, params) {
  if (!pool) throw new Error('DATABASE_NOT_AVAILABLE');
  
  const { bot_slug, telegram_id, transaction_id, correlation_id, now = new Date(), downsell_id_filter } = params;
  
  if (!bot_slug) throw new Error('MISSING_BOT_SLUG');
  if (!telegram_id) throw new Error('MISSING_TELEGRAM_ID');
  if (!transaction_id) throw new Error('MISSING_TRANSACTION_ID');
  
  try {
    // Buscar downsells ativos com after_pix=true
    let query = `
      SELECT id, delay_minutes
      FROM public.bot_downsells
      WHERE slug = $1 AND active = true AND after_pix = true
    `;
    
    const queryParams = [bot_slug];
    
    // Filtro opcional para testes
    if (downsell_id_filter) {
      query += ` AND id = $2`;
      queryParams.push(downsell_id_filter);
    }
    
    const result = await pool.query(query, queryParams);
    let scheduled = 0;
    
    for (const downsell of result.rows) {
      const scheduled_at = new Date(now.getTime() + (downsell.delay_minutes * 60 * 1000));
      const event_id = `dw:${bot_slug}:${telegram_id}:${downsell.id}:${transaction_id}:${scheduled_at.toISOString()}`;
      
      const insertQuery = `
        INSERT INTO public.downsells_queue (
          bot_slug, telegram_id, downsell_id, transaction_id, trigger,
          scheduled_at, status, meta, event_id, created_at, updated_at
        )
        VALUES ($1, $2, $3, $4, 'pix', $5, 'pending', $6, $7, now(), now())
        ON CONFLICT (event_id) DO NOTHING
      `;
      
      const meta = { correlation_id, scheduled_by: 'pix_trigger', transaction_id };
      const insertResult = await pool.query(insertQuery, [
        bot_slug,
        telegram_id,
        downsell.id,
        transaction_id,
        scheduled_at,
        JSON.stringify(meta),
        event_id
      ]);
      
      if (insertResult.rowCount > 0) {
        scheduled++;
        observe('downsells_scheduled_pix', 1, { bot: bot_slug });
        console.info('[DOWNSELL][SCHEDULED][PIX]', {
          bot_slug,
          telegram_id,
          downsell_id: downsell.id,
          transaction_id,
          scheduled_at: scheduled_at.toISOString(),
          event_id
        });
      }
    }
    
    return scheduled;
  } catch (err) {
    console.error('[DOWNSELL][SCHEDULE_PIX][ERR]', {
      bot_slug,
      telegram_id,
      transaction_id,
      error: err.message
    });
    throw err;
  }
}

/**
 * [DEPRECATED] Agenda um downsell para um usuário (mantido para compatibilidade)
 * @param {object} pool - Pool PostgreSQL
 * @param {object} params - { downsell_id, slug, tg_id, delay_seconds }
 * @returns {Promise<object>}
 */
async function scheduleDownsell(pool, params) {
  if (!pool) throw new Error('DATABASE_NOT_AVAILABLE');
  
  const { downsell_id, slug, tg_id, delay_seconds } = params;
  
  if (!downsell_id) throw new Error('MISSING_DOWNSELL_ID');
  if (!slug) throw new Error('MISSING_SLUG');
  if (!tg_id) throw new Error('MISSING_TG_ID');
  
  const scheduleAt = new Date(Date.now() + (delay_seconds * 1000));
  const telegram_id = typeof tg_id === 'string' ? parseInt(tg_id, 10) : tg_id;
  const event_id = `dw:${slug}:${telegram_id}:${downsell_id}:legacy:${scheduleAt.toISOString()}`;
  
  const query = `
    INSERT INTO public.downsells_queue (
      bot_slug, telegram_id, downsell_id, transaction_id, trigger,
      scheduled_at, status, meta, event_id, created_at, updated_at
    )
    VALUES ($1, $2, $3, NULL, 'start', $4, 'pending', '{"legacy":true}'::jsonb, $5, now(), now())
    ON CONFLICT (event_id) DO NOTHING
    RETURNING id, downsell_id, bot_slug, telegram_id, scheduled_at, status, created_at
  `;
  
  const result = await pool.query(query, [slug, telegram_id, downsell_id, scheduleAt, event_id]);
  
  if (result.rowCount > 0) {
    observe('downsell_scheduled', 1, { bot: slug });
    console.info('[DOWNSELL][SCHEDULED][LEGACY]', {
      downsell_id,
      slug,
      tg_id,
      schedule_at: scheduleAt.toISOString()
    });
  }
  
  return result.rows[0] || null;
}

/**
 * Busca downsells pendentes prontos para envio
 * @param {object} pool - Pool PostgreSQL
 * @param {number} limit - Limite de registros
 * @returns {Promise<Array>}
 */
async function getPendingDownsells(pool, limit = 100) {
  if (!pool) throw new Error('DATABASE_NOT_AVAILABLE');
  
  const query = `
    SELECT 
      dq.id, dq.downsell_id, dq.bot_slug, dq.telegram_id, 
      dq.scheduled_at, dq.trigger, dq.transaction_id, dq.event_id,
      dq.attempts, dq.meta,
      bd.content, bd.name
    FROM public.downsells_queue dq
    JOIN public.bot_downsells bd ON bd.id = dq.downsell_id
    WHERE dq.status = 'pending' 
      AND dq.scheduled_at <= now()
      AND bd.active = true
    ORDER BY dq.scheduled_at ASC
    LIMIT $1
  `;
  
  const result = await pool.query(query, [limit]);
  return result.rows;
}

/**
 * Marca downsell como enviado
 * @param {object} pool - Pool PostgreSQL
 * @param {number} queueId - ID na fila
 * @param {object} messageInfo - { message_id }
 * @returns {Promise<boolean>}
 */
async function markDownsellSent(pool, queueId, messageInfo = {}) {
  if (!pool) throw new Error('DATABASE_NOT_AVAILABLE');
  if (!queueId) throw new Error('MISSING_QUEUE_ID');
  
  const meta = messageInfo.message_id ? { message_id: messageInfo.message_id } : {};
  
  const query = `
    UPDATE public.downsells_queue
    SET status = 'sent', 
        meta = meta || $2::jsonb,
        updated_at = now(), 
        last_attempt_at = now()
    WHERE id = $1
  `;
  
  const result = await pool.query(query, [queueId, JSON.stringify(meta)]);
  return result.rowCount > 0;
}

/**
 * Marca downsell como falho
 * @param {object} pool - Pool PostgreSQL
 * @param {number} queueId - ID na fila
 * @param {string} errorMessage - Mensagem de erro
 * @returns {Promise<boolean>}
 */
async function markDownsellFailed(pool, queueId, errorMessage) {
  if (!pool) throw new Error('DATABASE_NOT_AVAILABLE');
  if (!queueId) throw new Error('MISSING_QUEUE_ID');
  
  const query = `
    UPDATE public.downsells_queue
    SET status = 'failed', 
        attempts = attempts + 1,
        cancel_reason = $2,
        updated_at = now(),
        last_attempt_at = now()
    WHERE id = $1
  `;
  
  const result = await pool.query(query, [queueId, errorMessage]);
  return result.rowCount > 0;
}

/**
 * Marca downsell como pulado (skipped)
 * @param {object} pool - Pool PostgreSQL
 * @param {number} queueId - ID na fila
 * @param {string} reason - Razão do skip
 * @returns {Promise<boolean>}
 */
async function markDownsellSkipped(pool, queueId, reason) {
  if (!pool) throw new Error('DATABASE_NOT_AVAILABLE');
  if (!queueId) throw new Error('MISSING_QUEUE_ID');
  
  const query = `
    UPDATE public.downsells_queue
    SET status = 'skipped',
        cancel_reason = $2,
        updated_at = now()
    WHERE id = $1
  `;
  
  const result = await pool.query(query, [queueId, reason]);
  return result.rowCount > 0;
}

/**
 * Cancela downsells pendentes ao pagar
 * @param {object} pool - Pool PostgreSQL
 * @param {object} params - { bot_slug, telegram_id, transaction_id }
 * @returns {Promise<number>} Quantidade cancelada
 */
async function cancelDownsellsOnPayment(pool, params) {
  if (!pool) throw new Error('DATABASE_NOT_AVAILABLE');
  
  const { bot_slug, telegram_id, transaction_id } = params;
  
  if (!bot_slug) throw new Error('MISSING_BOT_SLUG');
  if (!telegram_id) throw new Error('MISSING_TELEGRAM_ID');
  
  try {
    // Cancela todos os pendentes do usuário (ambos gatilhos)
    const query = `
      UPDATE public.downsells_queue
      SET status = 'canceled', 
          cancel_reason = 'paid',
          updated_at = now()
      WHERE bot_slug = $1 
        AND telegram_id = $2 
        AND status = 'pending'
        AND (transaction_id = $3 OR trigger = 'start')
    `;
    
    const result = await pool.query(query, [bot_slug, telegram_id, transaction_id]);
    
    if (result.rowCount > 0) {
      observe('downsells_canceled_paid', result.rowCount, { bot: bot_slug });
      console.info('[DOWNSELL][CANCEL][PAID]', { 
        bot_slug, 
        telegram_id, 
        transaction_id,
        count: result.rowCount 
      });
    }
    
    return result.rowCount;
  } catch (err) {
    console.error('[DOWNSELL][CANCEL_PAYMENT][ERR]', {
      bot_slug,
      telegram_id,
      transaction_id,
      error: err.message
    });
    throw err;
  }
}

/**
 * Cancela downsells pendentes ao expirar PIX
 * @param {object} pool - Pool PostgreSQL
 * @param {string} transaction_id - ID da transação expirada
 * @returns {Promise<number>} Quantidade cancelada
 */
async function cancelDownsellsOnExpiration(pool, transaction_id) {
  if (!pool) throw new Error('DATABASE_NOT_AVAILABLE');
  if (!transaction_id) throw new Error('MISSING_TRANSACTION_ID');
  
  try {
    const query = `
      UPDATE public.downsells_queue
      SET status = 'canceled',
          cancel_reason = 'expired',
          updated_at = now()
      WHERE transaction_id = $1 AND status = 'pending'
    `;
    
    const result = await pool.query(query, [transaction_id]);
    
    if (result.rowCount > 0) {
      console.info('[DOWNSELL][CANCEL][EXPIRED]', { 
        transaction_id,
        count: result.rowCount 
      });
    }
    
    return result.rowCount;
  } catch (err) {
    console.error('[DOWNSELL][CANCEL_EXPIRATION][ERR]', {
      transaction_id,
      error: err.message
    });
    throw err;
  }
}

/**
 * [DEPRECATED] Cancela downsells pendentes para um usuário (mantido para compatibilidade)
 * @param {object} pool - Pool PostgreSQL
 * @param {string} slug - Slug do bot
 * @param {string} tg_id - ID do usuário no Telegram
 * @returns {Promise<number>} Quantidade cancelada
 */
async function cancelPendingDownsells(pool, slug, tg_id) {
  if (!pool) throw new Error('DATABASE_NOT_AVAILABLE');
  if (!slug) throw new Error('MISSING_SLUG');
  if (!tg_id) throw new Error('MISSING_TG_ID');
  
  const telegram_id = typeof tg_id === 'string' ? parseInt(tg_id, 10) : tg_id;
  
  const query = `
    UPDATE public.downsells_queue
    SET status = 'canceled', 
        cancel_reason = 'manual',
        updated_at = now()
    WHERE bot_slug = $1 AND telegram_id = $2 AND status = 'pending'
  `;
  
  const result = await pool.query(query, [slug, telegram_id]);
  
  if (result.rowCount > 0) {
    console.info('[DOWNSELL][CANCELED][LEGACY]', { slug, tg_id, count: result.rowCount });
  }
  
  return result.rowCount;
}

/**
 * Obtém estatísticas de downsells
 * @param {object} pool - Pool PostgreSQL
 * @param {string} slug - Slug do bot (opcional)
 * @returns {Promise<object>}
 */
async function getDownsellStats(pool, slug = null) {
  if (!pool) throw new Error('DATABASE_NOT_AVAILABLE');
  
  const whereClause = slug ? 'WHERE slug = $1' : '';
  const params = slug ? [slug] : [];
  
  const query = `
    SELECT 
      status,
      COUNT(*) as count
    FROM public.downsells_queue
    ${whereClause}
    GROUP BY status
  `;
  
  const result = await pool.query(query, params);
  
  const stats = {
    pending: 0,
    sent: 0,
    failed: 0,
    canceled: 0
  };
  
  result.rows.forEach(row => {
    const status = row.status.toLowerCase();
    if (stats.hasOwnProperty(status)) {
      stats[status] = parseInt(row.count, 10);
    }
  });
  
  return stats;
}

module.exports = {
  listDownsells,
  createDownsell,
  updateDownsell,
  deleteDownsell,
  scheduleDownsell, // deprecated
  scheduleDownsellsForStart,
  scheduleDownsellsForPix,
  getPendingDownsells,
  markDownsellSent,
  markDownsellFailed,
  markDownsellSkipped,
  cancelPendingDownsells, // deprecated
  cancelDownsellsOnPayment,
  cancelDownsellsOnExpiration,
  getDownsellStats
};
