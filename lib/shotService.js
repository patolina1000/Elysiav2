/**
 * Serviço de disparo/broadcast V2
 * Sistema completo de disparos com agendamento, segmentação e dedupe
 */

const { observe } = require('./metricsService');
const { hasUnpaidPix } = require('./pixEligibilityService');

/**
 * Lista disparos de um bot com filtros
 * @param {object} pool - Pool PostgreSQL
 * @param {string} slug - Slug do bot
 * @param {object} filters - Filtros opcionais { status, search }
 * @returns {Promise<Array>}
 */
async function listShots(pool, slug, filters = {}) {
  if (!pool) throw new Error('DATABASE_NOT_AVAILABLE');
  if (!slug) throw new Error('MISSING_SLUG');
  
  let query = `
    SELECT id, bot_slug, slug, title, message, parse_mode, filters, 
           status, trigger, scheduled_at, total_targets, sent_count, failed_count,
           created_by, created_at, updated_at, started_at, completed_at
    FROM public.shots
    WHERE (bot_slug = $1 OR slug = $1)
  `;
  
  const params = [slug];
  let paramIndex = 2;
  
  // Filtro por status
  if (filters.status) {
    query += ` AND status = $${paramIndex}`;
    params.push(filters.status);
    paramIndex++;
  }
  
  // Busca textual
  if (filters.search) {
    query += ` AND (title ILIKE $${paramIndex} OR message::text ILIKE $${paramIndex})`;
    params.push(`%${filters.search}%`);
    paramIndex++;
  }
  
  query += ` ORDER BY created_at DESC LIMIT 100`;
  
  const result = await pool.query(query, params);
  return result.rows;
}

/**
 * Obtém detalhes de um disparo com estatísticas
 * @param {object} pool - Pool PostgreSQL
 * @param {number} shotId - ID do disparo
 * @returns {Promise<object>}
 */
async function getShot(pool, shotId) {
  if (!pool) throw new Error('DATABASE_NOT_AVAILABLE');
  if (!shotId) throw new Error('MISSING_SHOT_ID');
  
  const query = `
    SELECT s.id, s.bot_slug, s.slug, s.title, s.message, s.parse_mode, s.filters, 
           s.status, s.trigger, s.scheduled_at, s.total_targets, s.sent_count, s.failed_count,
           s.created_by, s.created_at, s.updated_at, s.started_at, s.completed_at,
           COUNT(CASE WHEN sq.status = 'PENDING' THEN 1 END) as queued_count,
           COUNT(CASE WHEN sq.status = 'SENT' THEN 1 END) as actual_sent_count,
           COUNT(CASE WHEN sq.status = 'SKIPPED' THEN 1 END) as skipped_count,
           COUNT(CASE WHEN sq.status = 'FAILED' THEN 1 END) as actual_failed_count
    FROM public.shots s
    LEFT JOIN public.shots_queue sq ON sq.shot_id = s.id
    WHERE s.id = $1
    GROUP BY s.id
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
 * @param {object} params - { slug, title, content, media_refs, parse_mode, trigger, scheduled_at, filters, created_by }
 * @returns {Promise<object>}
 */
async function createShot(pool, params) {
  if (!pool) throw new Error('DATABASE_NOT_AVAILABLE');
  
  const { 
    slug, 
    title, 
    content,  // ✅ Agora aceita 'content' (como downsells)
    message,  // Mantém compatibilidade com 'message' (deprecated)
    media_refs,
    parse_mode = 'MarkdownV2',
    trigger = 'now',
    scheduled_at,
    filters = {},
    created_by 
  } = params;
  
  if (!slug) throw new Error('MISSING_SLUG');
  if (!title) throw new Error('MISSING_TITLE');
  
  // Aceitar tanto 'content' quanto 'message' para compatibilidade
  const messageContent = content || message;
  if (!messageContent) throw new Error('MISSING_CONTENT_OR_MESSAGE');
  
  // Validação e enriquecimento de media_refs
  let enrichedMediaRefs = [];
  
  if (media_refs) {
    if (!Array.isArray(media_refs)) {
      throw new Error('MEDIA_REFS_MUST_BE_ARRAY');
    }
    if (media_refs.length > 3) {
      throw new Error('MEDIA_REFS_MAX_3');
    }
    
    // Validar e enriquecer cada item com r2_key
    for (const item of media_refs) {
      if (!item.sha256 || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)) {
        throw new Error('INVALID_MEDIA_SHA256');
      }
      if (!item.kind || !['audio', 'video', 'photo'].includes(item.kind)) {
        throw new Error('INVALID_MEDIA_KIND');
      }
      
      // Se não tem r2_key, buscar do media_store
      if (!item.r2_key) {
        const mediaQuery = `
          SELECT r2_key, bytes
          FROM media_store
          WHERE sha256 = $1 AND kind = $2
          LIMIT 1
        `;
        const mediaResult = await pool.query(mediaQuery, [item.sha256, item.kind]);
        
        if (mediaResult.rowCount > 0) {
          enrichedMediaRefs.push({
            sha256: item.sha256,
            kind: item.kind,
            r2_key: mediaResult.rows[0].r2_key,
            bytes: mediaResult.rows[0].bytes
          });
        } else {
          console.warn('[SHOT][CREATE][MEDIA_NOT_FOUND]', {
            sha256: item.sha256,
            kind: item.kind
          });
          enrichedMediaRefs.push({
            sha256: item.sha256,
            kind: item.kind
          });
        }
      } else {
        enrichedMediaRefs.push({
          sha256: item.sha256,
          kind: item.kind,
          r2_key: item.r2_key,
          bytes: item.bytes
        });
      }
    }
  }
  
  // Parse do conteúdo
  const messageObj = typeof messageContent === 'string' ? JSON.parse(messageContent) : messageContent;
  
  if (!messageObj || !messageObj.text) throw new Error('MISSING_MESSAGE_TEXT');
  if (trigger !== 'now' && trigger !== 'schedule') throw new Error('INVALID_TRIGGER');
  if (trigger === 'schedule' && !scheduled_at) throw new Error('MISSING_SCHEDULED_AT');
  
  // Validar scheduled_at (não pode ser no passado)
  if (scheduled_at) {
    const scheduledDate = new Date(scheduled_at);
    if (scheduledDate < new Date()) {
      throw new Error('SCHEDULED_AT_IN_PAST');
    }
  }
  
  const filtersObj = typeof filters === 'string' ? JSON.parse(filters) : filters;
  
  // Usar parse_mode do objeto se existir, senão usar o passado como parâmetro
  const finalParseMode = messageObj.parse_mode || parse_mode || 'MarkdownV2';
  
  const query = `
    INSERT INTO public.shots (
      bot_slug, slug, title, content, message, media_refs, parse_mode, trigger, scheduled_at, 
      filters, status, created_by, created_at, updated_at
    )
    VALUES ($1, $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now(), now())
    RETURNING id, bot_slug, slug, title, content, message, media_refs, parse_mode, trigger, scheduled_at, 
              filters, status, created_by, created_at
  `;
  
  const status = trigger === 'schedule' ? 'scheduled' : 'draft';
  const messageJson = JSON.stringify(messageObj);
  
  const result = await pool.query(query, [
    slug,
    title,
    messageJson,  // content
    messageJson,  // message
    JSON.stringify(enrichedMediaRefs),  // media_refs
    finalParseMode,
    trigger,
    scheduled_at || null,
    JSON.stringify(filtersObj),
    status,
    created_by || 'admin'
  ]);
  
  console.info('[SHOT][CREATED]', { 
    shot_id: result.rows[0].id, 
    slug, 
    title, 
    trigger,
    scheduled_at 
  });
  
  observe('shot_created', 1, { bot: slug });
  
  return result.rows[0];
}

/**
 * Atualiza um disparo (apenas se ainda for draft ou scheduled)
 * @param {object} pool - Pool PostgreSQL
 * @param {number} shotId - ID do disparo
 * @param {object} params - Campos para atualizar
 * @returns {Promise<object>}
 */
async function updateShot(pool, shotId, params) {
  if (!pool) throw new Error('DATABASE_NOT_AVAILABLE');
  if (!shotId) throw new Error('MISSING_SHOT_ID');
  
  const { title, content, message, media_refs, parse_mode, trigger, scheduled_at, filters } = params;
  
  const updates = [];
  const values = [];
  let paramIndex = 1;
  
  if (title) {
    updates.push(`title = $${paramIndex++}`);
    values.push(title);
  }
  
  // Aceitar tanto 'content' quanto 'message' para compatibilidade
  const messageContent = content || message;
  if (messageContent) {
    const messageObj = typeof messageContent === 'string' ? JSON.parse(messageContent) : messageContent;
    const messageJson = JSON.stringify(messageObj);
    updates.push(`message = $${paramIndex++}`);
    values.push(messageJson);
    // Também atualizar content para manter compatibilidade com constraint NOT NULL
    updates.push(`content = $${paramIndex++}`);
    values.push(messageJson);
  }
  
  // Validação e enriquecimento de media_refs
  if (media_refs !== undefined) {
    let enrichedMediaRefs = [];
    
    if (media_refs) {
      if (!Array.isArray(media_refs)) {
        throw new Error('MEDIA_REFS_MUST_BE_ARRAY');
      }
      if (media_refs.length > 3) {
        throw new Error('MEDIA_REFS_MAX_3');
      }
      
      // Validar e enriquecer cada item com r2_key
      for (const item of media_refs) {
        if (!item.sha256 || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)) {
          throw new Error('INVALID_MEDIA_SHA256');
        }
        if (!item.kind || !['audio', 'video', 'photo'].includes(item.kind)) {
          throw new Error('INVALID_MEDIA_KIND');
        }
        
        // Se não tem r2_key, buscar do media_store
        if (!item.r2_key) {
          const mediaQuery = `
            SELECT r2_key, bytes
            FROM media_store
            WHERE sha256 = $1 AND kind = $2
            LIMIT 1
          `;
          const mediaResult = await pool.query(mediaQuery, [item.sha256, item.kind]);
          
          if (mediaResult.rowCount > 0) {
            enrichedMediaRefs.push({
              sha256: item.sha256,
              kind: item.kind,
              r2_key: mediaResult.rows[0].r2_key,
              bytes: mediaResult.rows[0].bytes
            });
          } else {
            console.warn('[SHOT][UPDATE][MEDIA_NOT_FOUND]', {
              sha256: item.sha256,
              kind: item.kind
            });
            enrichedMediaRefs.push({
              sha256: item.sha256,
              kind: item.kind
            });
          }
        } else {
          enrichedMediaRefs.push({
            sha256: item.sha256,
            kind: item.kind,
            r2_key: item.r2_key,
            bytes: item.bytes
          });
        }
      }
    }
    
    updates.push(`media_refs = $${paramIndex++}`);
    values.push(JSON.stringify(enrichedMediaRefs));
  }
  
  if (parse_mode) {
    updates.push(`parse_mode = $${paramIndex++}`);
    values.push(parse_mode);
  }
  
  if (trigger) {
    updates.push(`trigger = $${paramIndex++}`);
    values.push(trigger);
  }
  
  if (scheduled_at !== undefined) {
    updates.push(`scheduled_at = $${paramIndex++}`);
    values.push(scheduled_at);
  }
  
  if (filters) {
    const filtersObj = typeof filters === 'string' ? JSON.parse(filters) : filters;
    updates.push(`filters = $${paramIndex++}`);
    values.push(JSON.stringify(filtersObj));
  }
  
  if (updates.length === 0) {
    throw new Error('NO_FIELDS_TO_UPDATE');
  }
  
  updates.push('updated_at = now()');
  values.push(shotId);
  
  const query = `
    UPDATE public.shots
    SET ${updates.join(', ')}
    WHERE id = $${paramIndex} AND status IN ('draft', 'scheduled')
    RETURNING *
  `;
  
  const result = await pool.query(query, values);
  
  if (result.rowCount === 0) {
    throw new Error('SHOT_NOT_FOUND_OR_NOT_EDITABLE');
  }
  
  console.info('[SHOT][UPDATED]', { shot_id: shotId });
  
  return result.rows[0];
}

/**
 * Deleta um disparo (apenas se draft ou scheduled e não começou)
 * @param {object} pool - Pool PostgreSQL
 * @param {number} shotId - ID do disparo
 * @returns {Promise<boolean>}
 */
async function deleteShot(pool, shotId) {
  if (!pool) throw new Error('DATABASE_NOT_AVAILABLE');
  if (!shotId) throw new Error('MISSING_SHOT_ID');
  
  const query = `
    DELETE FROM public.shots
    WHERE id = $1 AND status IN ('draft', 'scheduled') AND started_at IS NULL
    RETURNING id, slug
  `;
  
  const result = await pool.query(query, [shotId]);
  
  if (result.rowCount > 0) {
    console.info('[SHOT][DELETED]', { shot_id: shotId, slug: result.rows[0].slug });
    return true;
  }
  
  return false;
}

/**
 * Duplica um disparo
 * @param {object} pool - Pool PostgreSQL
 * @param {number} shotId - ID do disparo a duplicar
 * @returns {Promise<object>}
 */
async function duplicateShot(pool, shotId) {
  if (!pool) throw new Error('DATABASE_NOT_AVAILABLE');
  if (!shotId) throw new Error('MISSING_SHOT_ID');
  
  const original = await getShot(pool, shotId);
  
  const query = `
    INSERT INTO public.shots (
      bot_slug, slug, title, message, parse_mode, trigger, scheduled_at, 
      filters, status, created_by, created_at, updated_at
    )
    VALUES ($1, $2, $3, $4, $5, 'now', NULL, $6, 'draft', $7, now(), now())
    RETURNING id, bot_slug, slug, title, message, status, created_at
  `;
  
  const result = await pool.query(query, [
    original.bot_slug || original.slug,
    original.slug,
    `${original.title} (Cópia)`,
    original.message,
    original.parse_mode,
    original.filters,
    original.created_by || 'admin'
  ]);
  
  console.info('[SHOT][DUPLICATED]', { 
    original_id: shotId, 
    new_id: result.rows[0].id 
  });
  
  return result.rows[0];
}

/**
 * Popula a fila de um disparo com os alvos (baseado em filtros)
 * @param {object} pool - Pool PostgreSQL
 * @param {number} shotId - ID do disparo
 * @returns {Promise<number>} Quantidade de alvos enfileirados
 */
async function populateShotQueue(pool, shotId) {
  console.log('[DEBUG][POPULATE_QUEUE][1] Entrada:', { 
    shotId, 
    type: typeof shotId,
    hasPool: !!pool 
  });
  
  if (!pool) throw new Error('DATABASE_NOT_AVAILABLE');
  if (!shotId) throw new Error('MISSING_SHOT_ID');
  
  // Garantir que shotId seja um número inteiro
  const shotIdInt = parseInt(shotId, 10);
  
  console.log('[DEBUG][POPULATE_QUEUE][2] Após parseInt:', { 
    shotIdInt, 
    type: typeof shotIdInt,
    isNaN: isNaN(shotIdInt),
    original: shotId
  });
  
  if (isNaN(shotIdInt)) throw new Error('INVALID_SHOT_ID_TYPE');
  
  console.log('[DEBUG][POPULATE_QUEUE][3] Buscando shot:', { shotIdInt });
  
  const shot = await getShot(pool, shotIdInt);
  const filters = shot.filters || {};
  const botSlug = shot.bot_slug || shot.slug;
  
  console.log('[DEBUG][POPULATE_QUEUE][4] Shot encontrado:', { 
    shotIdInt, 
    botSlug, 
    filters: JSON.stringify(filters)
  });
  
  // Query base: todos que deram /start
  let targetQuery = `
    WITH started_users AS (
      SELECT DISTINCT tg_id, bot_slug
      FROM public.funnel_events
      WHERE bot_slug = $2 
        AND event_name = 'start'
    )
  `;
  
  // Adicionar filtro de PIX não pago se necessário
  if (filters.has_unpaid_pix) {
    targetQuery += `,
    unpaid_pix_users AS (
      SELECT DISTINCT pc.tg_id
      FROM (
        SELECT DISTINCT tg_id, transaction_id
        FROM public.funnel_events
        WHERE bot_slug = $2 
          AND event_name = 'pix_created'
          AND occurred_at > now() - interval '7 days'
      ) pc
      LEFT JOIN (
        SELECT DISTINCT transaction_id
        FROM public.funnel_events
        WHERE bot_slug = $2 
          AND event_name = 'payment_approved'
      ) pp ON pp.transaction_id = pc.transaction_id
      WHERE pp.transaction_id IS NULL
    )
    `;
  }
  
  // Adicionar filtro de excluir pagos se necessário
  if (filters.exclude_paid !== false) { // default true
    targetQuery += `,
    paid_users AS (
      SELECT DISTINCT tg_id
      FROM public.funnel_events
      WHERE bot_slug = $2 
        AND event_name = 'payment_approved'
    )
    `;
  }
  
  // Query final de inserção
  targetQuery += `
    INSERT INTO public.shots_queue (
      shot_id, bot_slug, slug, tg_id, telegram_id, event_id, 
      status, created_at, updated_at
    )
    SELECT 
      $1::bigint, 
      $2,
      $2,
      su.tg_id,
      su.tg_id::bigint,
      'sh:' || $2 || ':' || $1::text || ':' || su.tg_id,
      'PENDING',
      now(),
      now()
    FROM started_users su
  `;
  
  // Aplicar filtros
  if (filters.has_unpaid_pix) {
    targetQuery += `
    INNER JOIN unpaid_pix_users upu ON upu.tg_id = su.tg_id
    `;
  }
  
  if (filters.exclude_paid !== false) {
    targetQuery += `
    LEFT JOIN paid_users pu ON pu.tg_id = su.tg_id
    WHERE pu.tg_id IS NULL
    `;
  }
  
  targetQuery += `
    ON CONFLICT (shot_id, telegram_id) DO NOTHING
  `;
  
  console.log('[DEBUG][POPULATE_QUEUE][5] Antes da query:', { 
    shotIdInt, 
    shotIdIntType: typeof shotIdInt,
    botSlug, 
    botSlugType: typeof botSlug,
    params: [shotIdInt, botSlug],
    queryLength: targetQuery.length
  });
  
  console.log('[DEBUG][POPULATE_QUEUE][6] Query SQL:', targetQuery);
  
  const result = await pool.query(targetQuery, [shotIdInt, botSlug]);
  const count = result.rowCount;
  
  console.log('[DEBUG][POPULATE_QUEUE][7] Query executada:', { count });
  
  // Atualizar total_targets e mudar status para queued
  await pool.query(`
    UPDATE public.shots
    SET total_targets = $1, status = 'queued', updated_at = now()
    WHERE id = $2
  `, [count, shotIdInt]);
  
  console.info('[SHOT][QUEUE_POPULATED]', { shot_id: shotIdInt, slug: botSlug, count, filters });
  observe('shot_queue_populated', count, { bot: botSlug });
  
  return count;
}

/**
 * Busca disparos agendados que já devem ser executados
 * @param {object} pool - Pool PostgreSQL
 * @returns {Promise<Array>}
 */
async function getDueScheduledShots(pool) {
  if (!pool) throw new Error('DATABASE_NOT_AVAILABLE');
  
  const query = `
    SELECT id, bot_slug, slug, title, scheduled_at
    FROM public.shots
    WHERE status = 'scheduled'
      AND trigger = 'schedule'
      AND scheduled_at <= now()
    ORDER BY scheduled_at ASC
    LIMIT 10
  `;
  
  const result = await pool.query(query);
  return result.rows;
}

/**
 * Busca próximos alvos pendentes de disparos ativos
 * @param {object} pool - Pool PostgreSQL
 * @param {number} limit - Limite de registros
 * @returns {Promise<Array>}
 */
async function getPendingShotTargets(pool, limit = 50) {
  if (!pool) throw new Error('DATABASE_NOT_AVAILABLE');
  
  const query = `
    SELECT sq.id, sq.shot_id, sq.bot_slug, sq.slug, sq.tg_id, sq.telegram_id, 
           sq.attempts, sq.event_id,
           s.message, s.parse_mode, s.media_refs
    FROM public.shots_queue sq
    JOIN public.shots s ON s.id = sq.shot_id
    WHERE sq.status = 'PENDING'
      AND s.status = 'sending'
    ORDER BY sq.id ASC
    LIMIT $1
  `;
  
  const result = await pool.query(query, [limit]);
  return result.rows;
}

/**
 * Marca alvo como enviado
 * @param {object} pool - Pool PostgreSQL
 * @param {number} queueId - ID na fila
 * @param {object} meta - { message_id }
 * @returns {Promise<boolean>}
 */
async function markShotTargetSent(pool, queueId, meta = {}) {
  if (!pool) throw new Error('DATABASE_NOT_AVAILABLE');
  if (!queueId) throw new Error('MISSING_QUEUE_ID');
  
  const query = `
    UPDATE public.shots_queue
    SET status = 'SENT', 
        message_id = $2,
        updated_at = now(), 
        last_attempt_at = now()
    WHERE id = $1
    RETURNING shot_id
  `;
  
  const result = await pool.query(query, [queueId, meta.message_id || null]);
  
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
 * Marca alvo como pulado (skipped)
 * @param {object} pool - Pool PostgreSQL
 * @param {number} queueId - ID na fila
 * @param {string} reason - Razão do skip
 * @returns {Promise<boolean>}
 */
async function markShotTargetSkipped(pool, queueId, reason) {
  if (!pool) throw new Error('DATABASE_NOT_AVAILABLE');
  if (!queueId) throw new Error('MISSING_QUEUE_ID');
  
  const query = `
    UPDATE public.shots_queue
    SET status = 'SKIPPED',
        error_message = $2,
        updated_at = now(),
        last_attempt_at = now()
    WHERE id = $1
  `;
  
  await pool.query(query, [queueId, reason]);
  return true;
}

/**
 * Inicia um disparo (popula fila e muda status para sending)
 * @param {object} pool - Pool PostgreSQL
 * @param {number} shotId - ID do disparo
 * @returns {Promise<number>} Quantidade de alvos enfileirados
 */
async function startShot(pool, shotId) {
  console.log('[DEBUG][START_SHOT][1] Entrada:', { 
    shotId, 
    type: typeof shotId,
    hasPool: !!pool 
  });
  
  if (!pool) throw new Error('DATABASE_NOT_AVAILABLE');
  if (!shotId) throw new Error('MISSING_SHOT_ID');
  
  console.log('[DEBUG][START_SHOT][2] Chamando populateShotQueue com:', { shotId, type: typeof shotId });
  
  // Primeiro popula a fila
  const count = await populateShotQueue(pool, shotId);
  
  console.log('[DEBUG][START_SHOT][3] Fila populada:', { count });
  
  // Depois muda status para sending
  const query = `
    UPDATE public.shots
    SET status = 'sending', started_at = now(), updated_at = now()
    WHERE id = $1 AND status IN ('draft', 'queued', 'scheduled')
    RETURNING id, slug, bot_slug
  `;
  
  const result = await pool.query(query, [shotId]);
  
  if (result.rowCount > 0) {
    console.info('[SHOT][STARTED]', { 
      shot_id: shotId, 
      slug: result.rows[0].bot_slug || result.rows[0].slug,
      target_count: count
    });
    observe('shot_started', 1, { bot: result.rows[0].bot_slug || result.rows[0].slug });
  }
  
  return count;
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
    SET status = 'canceled', updated_at = now()
    WHERE id = $1 AND status IN ('draft', 'queued', 'scheduled', 'sending')
    RETURNING id, slug, bot_slug
  `;
  
  const result = await pool.query(query, [shotId]);
  
  if (result.rowCount > 0) {
    // Marcar todos pendentes como SKIPPED
    await pool.query(`
      UPDATE public.shots_queue
      SET status = 'SKIPPED', error_message = 'canceled_by_user', updated_at = now()
      WHERE shot_id = $1 AND status = 'PENDING'
    `, [shotId]);
    
    console.info('[SHOT][CANCELED]', { 
      shot_id: shotId, 
      slug: result.rows[0].bot_slug || result.rows[0].slug 
    });
    observe('shot_canceled', 1, { bot: result.rows[0].bot_slug || result.rows[0].slug });
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
    SET status = 'done', completed_at = now(), updated_at = now()
    WHERE id = $1 AND status = 'sending'
    RETURNING id, slug, bot_slug
  `;
  
  const result = await pool.query(query, [shotId]);
  
  if (result.rowCount > 0) {
    console.info('[SHOT][COMPLETED]', { 
      shot_id: shotId, 
      slug: result.rows[0].bot_slug || result.rows[0].slug 
    });
    observe('shot_completed', 1, { bot: result.rows[0].bot_slug || result.rows[0].slug });
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

/**
 * Arredonda horário para próximo múltiplo de 15 minutos
 * @param {Date} date - Data/hora
 * @returns {Date}
 */
function roundToNext15Minutes(date) {
  const minutes = date.getMinutes();
  const roundedMinutes = Math.ceil(minutes / 15) * 15;
  
  const result = new Date(date);
  result.setMinutes(roundedMinutes, 0, 0);
  
  return result;
}

module.exports = {
  listShots,
  getShot,
  createShot,
  updateShot,
  deleteShot,
  duplicateShot,
  populateShotQueue,
  getDueScheduledShots,
  getPendingShotTargets,
  markShotTargetSent,
  markShotTargetFailed,
  markShotTargetSkipped,
  startShot,
  cancelShot,
  completeShot,
  isShotComplete,
  roundToNext15Minutes
};
