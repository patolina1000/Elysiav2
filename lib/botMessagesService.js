/**
 * Serviço de mensagens configuráveis do /start por bot
 * Fonte de verdade: PostgreSQL (tabela bot_messages)
 */

const { escapeMarkdownV2 } = require('./sendService');

/**
 * Busca mensagens ativas do /start para um bot (ordenadas por sequence_order)
 * @param {object} pool - Pool PostgreSQL
 * @param {string} slug - Slug do bot
 * @returns {Promise<Array>} Lista de mensagens ordenadas
 */
async function getStartMessages(pool, slug) {
  if (!pool) {
    throw new Error('DATABASE_NOT_AVAILABLE');
  }
  
  if (!slug) {
    throw new Error('MISSING_SLUG');
  }
  
  const query = `
    SELECT 
      id, 
      slug, 
      sequence_order, 
      message_type, 
      content, 
      active,
      media_sha256,
      media_kind,
      media_r2_key
    FROM public.bot_messages
    WHERE slug = $1 AND active = true
    ORDER BY sequence_order ASC
  `;
  
  const result = await pool.query(query, [slug]);
  return result.rows;
}

/**
 * Cria ou atualiza uma mensagem do /start
 * @param {object} pool - Pool PostgreSQL
 * @param {object} params - { slug, sequence_order, message_type, content, active }
 * @returns {Promise<object>} Mensagem criada/atualizada
 */
async function upsertStartMessage(pool, params) {
  if (!pool) {
    throw new Error('DATABASE_NOT_AVAILABLE');
  }
  
  const { slug, sequence_order = 1, message_type = 'text', content, active = true } = params;
  
  if (!slug) {
    throw new Error('MISSING_SLUG');
  }
  
  if (!content) {
    throw new Error('MISSING_CONTENT');
  }
  
  // Validar content é um objeto
  const contentObj = typeof content === 'string' ? JSON.parse(content) : content;
  
  const query = `
    INSERT INTO public.bot_messages (slug, sequence_order, message_type, content, active, created_at, updated_at)
    VALUES ($1, $2, $3, $4, $5, now(), now())
    RETURNING id, slug, sequence_order, message_type, content, active, created_at, updated_at
  `;
  
  const result = await pool.query(query, [
    slug,
    sequence_order,
    message_type,
    JSON.stringify(contentObj),
    active
  ]);
  
  return result.rows[0];
}

/**
 * Atualiza uma mensagem existente
 * @param {object} pool - Pool PostgreSQL
 * @param {number} id - ID da mensagem
 * @param {object} params - { sequence_order, message_type, content, active }
 * @returns {Promise<object>} Mensagem atualizada
 */
async function updateStartMessage(pool, id, params) {
  if (!pool) {
    throw new Error('DATABASE_NOT_AVAILABLE');
  }
  
  if (!id) {
    throw new Error('MISSING_ID');
  }
  
  const { sequence_order, message_type, content, active } = params;
  const updates = [];
  const values = [];
  let paramIndex = 1;
  
  if (sequence_order !== undefined) {
    updates.push(`sequence_order = $${paramIndex++}`);
    values.push(sequence_order);
  }
  
  if (message_type !== undefined) {
    updates.push(`message_type = $${paramIndex++}`);
    values.push(message_type);
  }
  
  if (content !== undefined) {
    const contentObj = typeof content === 'string' ? JSON.parse(content) : content;
    updates.push(`content = $${paramIndex++}`);
    values.push(JSON.stringify(contentObj));
  }
  
  if (active !== undefined) {
    updates.push(`active = $${paramIndex++}`);
    values.push(active);
  }
  
  updates.push(`updated_at = now()`);
  values.push(id);
  
  const query = `
    UPDATE public.bot_messages
    SET ${updates.join(', ')}
    WHERE id = $${paramIndex}
    RETURNING id, slug, sequence_order, message_type, content, active, created_at, updated_at
  `;
  
  const result = await pool.query(query, values);
  
  if (result.rowCount === 0) {
    throw new Error('MESSAGE_NOT_FOUND');
  }
  
  return result.rows[0];
}

/**
 * Deleta uma mensagem
 * @param {object} pool - Pool PostgreSQL
 * @param {number} id - ID da mensagem
 * @returns {Promise<boolean>}
 */
async function deleteStartMessage(pool, id) {
  if (!pool) {
    throw new Error('DATABASE_NOT_AVAILABLE');
  }
  
  if (!id) {
    throw new Error('MISSING_ID');
  }
  
  const query = `DELETE FROM public.bot_messages WHERE id = $1`;
  const result = await pool.query(query, [id]);
  
  return result.rowCount > 0;
}

/**
 * Prepara mensagem para envio (escapa MarkdownV2 se necessário)
 * @param {object} message - Objeto da mensagem
 * @returns {object} Mensagem preparada para envio
 */
function prepareMessageForSend(message) {
  const content = typeof message.content === 'string' 
    ? JSON.parse(message.content) 
    : message.content;
  
  const prepared = {
    type: message.message_type,
    ...content
  };
  
  // Escapar texto se raw não for true
  if (prepared.text && !prepared.raw) {
    prepared.text = escapeMarkdownV2(prepared.text);
    prepared.raw = true; // já escapado
  }
  
  return prepared;
}

/**
 * Mensagem padrão de fallback (caso não haja mensagens configuradas)
 */
function getDefaultStartMessage() {
  return {
    message_type: 'text',
    content: {
      text: 'Olá! 👋\n\nBem-vindo ao bot!\n\nEste é um teste do serviço de envio automático.',
      parse_mode: 'MarkdownV2',
      raw: false // será escapado pelo prepareMessageForSend
    }
  };
}

/**
 * Busca mensagens com informações completas de mídia (usando view)
 * @param {object} pool - Pool PostgreSQL
 * @param {string} slug - Slug do bot
 * @returns {Promise<Array>} Lista de mensagens com info de mídia
 */
async function getMessagesWithMedia(pool, slug) {
  if (!pool) {
    throw new Error('DATABASE_NOT_AVAILABLE');
  }
  
  if (!slug) {
    throw new Error('MISSING_SLUG');
  }
  
  const query = `
    SELECT * FROM bot_messages_with_media
    WHERE slug = $1 AND active = true
    ORDER BY sequence_order ASC
  `;
  
  const result = await pool.query(query, [slug]);
  return result.rows;
}

/**
 * Adiciona mídia a uma mensagem existente
 * @param {object} pool - Pool PostgreSQL
 * @param {number} messageId - ID da mensagem
 * @param {object} mediaInfo - { sha256, kind, r2_key }
 * @returns {Promise<object>}
 */
async function addMediaToMessage(pool, messageId, mediaInfo) {
  if (!pool) {
    throw new Error('DATABASE_NOT_AVAILABLE');
  }
  
  const { sha256, kind, r2_key } = mediaInfo;
  
  if (!sha256 || !kind || !r2_key) {
    throw new Error('MISSING_MEDIA_INFO');
  }
  
  const query = `
    UPDATE public.bot_messages
    SET 
      media_sha256 = $1,
      media_kind = $2,
      media_r2_key = $3,
      message_type = $4,
      updated_at = now()
    WHERE id = $5
    RETURNING *
  `;
  
  const result = await pool.query(query, [sha256, kind, r2_key, kind, messageId]);
  
  if (result.rowCount === 0) {
    throw new Error('MESSAGE_NOT_FOUND');
  }
  
  return result.rows[0];
}

/**
 * Remove mídia de uma mensagem
 * @param {object} pool - Pool PostgreSQL
 * @param {number} messageId - ID da mensagem
 * @returns {Promise<object>}
 */
async function removeMediaFromMessage(pool, messageId) {
  if (!pool) {
    throw new Error('DATABASE_NOT_AVAILABLE');
  }
  
  const query = `
    UPDATE public.bot_messages
    SET 
      media_sha256 = NULL,
      media_kind = NULL,
      media_r2_key = NULL,
      message_type = 'text',
      updated_at = now()
    WHERE id = $1
    RETURNING *
  `;
  
  const result = await pool.query(query, [messageId]);
  
  if (result.rowCount === 0) {
    throw new Error('MESSAGE_NOT_FOUND');
  }
  
  return result.rows[0];
}

/**
 * Verifica se uma mensagem tem mídia pronta (cached)
 * @param {object} pool - Pool PostgreSQL
 * @param {object} message - Objeto da mensagem
 * @returns {Promise<object>} { hasMedia, isReady, cacheInfo }
 */
async function checkMessageMediaStatus(pool, message) {
  const hasMedia = !!(message.media_sha256 && message.media_kind);
  
  if (!hasMedia) {
    return { hasMedia: false, isReady: false, cacheInfo: null };
  }
  
  const query = `
    SELECT status, tg_file_id, warmup_at, last_error
    FROM media_cache
    WHERE bot_slug = $1 
      AND sha256 = $2 
      AND kind = $3
  `;
  
  const result = await pool.query(query, [message.slug, message.media_sha256, message.media_kind]);
  
  if (result.rowCount === 0) {
    return { hasMedia: true, isReady: false, cacheInfo: { status: 'not_cached' } };
  }
  
  const cache = result.rows[0];
  
  return {
    hasMedia: true,
    isReady: cache.status === 'ready' && !!cache.tg_file_id,
    cacheInfo: cache
  };
}

module.exports = {
  getStartMessages,
  upsertStartMessage,
  updateStartMessage,
  deleteStartMessage,
  prepareMessageForSend,
  getDefaultStartMessage,
  getMessagesWithMedia,
  addMediaToMessage,
  removeMediaFromMessage,
  checkMessageMediaStatus
};
