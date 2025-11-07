/**
 * Media Service - Gerencia armazenamento R2 e cache de file_id
 * Implementa estratégia cache-first para latência p95 < 500ms
 */

const { uploadMedia, downloadMedia, calculateSHA256, generateR2Key } = require('./r2Service');
const { observe } = require('./metricsService');

/**
 * Salva mídia no R2 e registra no media_store
 * @param {object} pool - Pool do PostgreSQL
 * @param {Buffer} buffer - Conteúdo da mídia
 * @param {string} bot_slug - Slug do bot
 * @param {string} kind - Tipo (photo/video/document/audio)
 * @param {object} metadata - Metadados (mime, ext, width, height, duration)
 * @returns {Promise<object>} Resultado da operação
 */
async function saveMedia(pool, buffer, bot_slug, kind, metadata = {}) {
  const startTime = Date.now();
  
  try {
    // 1. Upload para R2
    const uploadResult = await uploadMedia(buffer, bot_slug, kind, metadata);
    
    // 2. Registrar no media_store
    const query = `
      INSERT INTO media_store (
        bot_slug, kind, r2_key, r2_etag, bytes, sha256,
        ext, mime, width, height, duration
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (r2_key) DO UPDATE SET
        r2_etag = EXCLUDED.r2_etag,
        bytes = EXCLUDED.bytes,
        updated_at = now()
      RETURNING id, r2_key, sha256, bytes
    `;
    
    const values = [
      bot_slug,
      kind,
      uploadResult.r2_key,
      uploadResult.etag,
      uploadResult.bytes,
      uploadResult.sha256,
      metadata.ext || null,
      metadata.mime || null,
      metadata.width || null,
      metadata.height || null,
      metadata.duration || null
    ];
    
    const result = await pool.query(query, values);
    const row = result.rows[0];
    
    // 3. Criar registro inicial no media_cache com status 'warming'
    const cacheQuery = `
      INSERT INTO media_cache (bot_slug, sha256, kind, status)
      VALUES ($1, $2, $3, 'warming')
      ON CONFLICT (bot_slug, sha256, kind) DO UPDATE SET
        status = 'warming',
        updated_at = now()
    `;
    
    await pool.query(cacheQuery, [bot_slug, uploadResult.sha256, kind]);
    
    const latency = Date.now() - startTime;
    observe('media_save_ms', latency, { bot: bot_slug, kind });
    
    console.info('[MEDIA][SAVE][OK]', {
      bot_slug,
      kind,
      media_id: row.id,
      r2_key: row.r2_key,
      sha256: row.sha256,
      bytes: row.bytes,
      lat_ms: latency
    });
    
    return {
      ok: true,
      media_id: row.id,
      r2_key: row.r2_key,
      sha256: row.sha256,
      bytes: row.bytes
    };
  } catch (err) {
    const latency = Date.now() - startTime;
    observe('media_save_errors_total', 1, { bot: bot_slug, kind });
    
    console.error('[MEDIA][SAVE][ERR]', {
      bot_slug,
      kind,
      error: err.message,
      lat_ms: latency
    });
    
    throw err;
  }
}

/**
 * Busca file_id do cache
 * @param {object} pool - Pool do PostgreSQL
 * @param {string} bot_slug - Slug do bot
 * @param {string} sha256 - Hash do conteúdo
 * @param {string} kind - Tipo (photo/video/document/audio)
 * @returns {Promise<object|null>} Cache entry ou null
 */
async function getCachedFileId(pool, bot_slug, sha256, kind) {
  const startTime = Date.now();
  
  try {
    const query = `
      SELECT id, tg_file_id, tg_file_unique_id, status, warmup_at, last_error
      FROM media_cache
      WHERE bot_slug = $1 AND sha256 = $2 AND kind = $3 AND status = 'ready'
      LIMIT 1
    `;
    
    const result = await pool.query(query, [bot_slug, sha256, kind]);
    
    const latency = Date.now() - startTime;
    
    if (result.rowCount === 0) {
      observe('media_cache_hit', 0, { bot: bot_slug, kind });
      console.debug('[MEDIA][CACHE][MISS]', { bot_slug, sha256, kind, lat_ms: latency });
      return null;
    }
    
    const row = result.rows[0];
    observe('media_cache_hit', 1, { bot: bot_slug, kind });
    
    console.debug('[MEDIA][CACHE][HIT]', {
      bot_slug,
      sha256,
      kind,
      cache_id: row.id,
      file_id: row.tg_file_id?.slice(0, 20) + '...',
      lat_ms: latency
    });
    
    return {
      cache_id: row.id,
      file_id: row.tg_file_id,
      file_unique_id: row.tg_file_unique_id,
      warmup_at: row.warmup_at
    };
  } catch (err) {
    console.error('[MEDIA][CACHE][GET][ERR]', {
      bot_slug,
      sha256,
      kind,
      error: err.message
    });
    
    return null;
  }
}

/**
 * Registra entrada no cache (status: warming)
 * @param {object} pool - Pool do PostgreSQL
 * @param {string} bot_slug - Slug do bot
 * @param {string} sha256 - Hash do conteúdo
 * @param {string} kind - Tipo
 * @returns {Promise<object>} Cache entry criada
 */
async function createCacheEntry(pool, bot_slug, sha256, kind) {
  try {
    const query = `
      INSERT INTO media_cache (bot_slug, sha256, kind, status)
      VALUES ($1, $2, $3, 'warming')
      ON CONFLICT (bot_slug, sha256, kind) DO UPDATE SET
        status = 'warming',
        last_error = NULL,
        updated_at = now()
      RETURNING id, status
    `;
    
    const result = await pool.query(query, [bot_slug, sha256, kind]);
    const row = result.rows[0];
    
    console.info('[MEDIA][CACHE][CREATE]', {
      bot_slug,
      sha256,
      kind,
      cache_id: row.id,
      status: row.status
    });
    
    return {
      cache_id: row.id,
      status: row.status
    };
  } catch (err) {
    console.error('[MEDIA][CACHE][CREATE][ERR]', {
      bot_slug,
      sha256,
      kind,
      error: err.message
    });
    
    throw err;
  }
}

/**
 * Atualiza cache com file_id após warmup bem-sucedido
 * @param {object} pool - Pool do PostgreSQL
 * @param {string} bot_slug - Slug do bot
 * @param {string} sha256 - Hash do conteúdo
 * @param {string} kind - Tipo
 * @param {object} warmupResult - Resultado do warmup
 * @returns {Promise<boolean>}
 */
async function updateCacheWithFileId(pool, bot_slug, sha256, kind, warmupResult) {
  const startTime = Date.now();
  
  try {
    const {
      file_id,
      file_unique_id,
      warmup_chat_id,
      warmup_message_id
    } = warmupResult;
    
    const query = `
      UPDATE media_cache
      SET 
        tg_file_id = $1,
        tg_file_unique_id = $2,
        warmup_chat_id = $3,
        warmup_message_id = $4,
        warmup_at = now(),
        status = 'ready',
        last_error = NULL,
        updated_at = now()
      WHERE bot_slug = $5 AND sha256 = $6 AND kind = $7
      RETURNING id
    `;
    
    const result = await pool.query(query, [
      file_id,
      file_unique_id,
      warmup_chat_id,
      warmup_message_id,
      bot_slug,
      sha256,
      kind
    ]);
    
    const latency = Date.now() - startTime;
    
    if (result.rowCount === 0) {
      console.warn('[MEDIA][CACHE][UPDATE][NOT_FOUND]', { bot_slug, sha256, kind });
      return false;
    }
    
    observe('media_cache_update_ms', latency, { bot: bot_slug, kind });
    
    console.info('[MEDIA][CACHE][UPDATE][OK]', {
      bot_slug,
      sha256,
      kind,
      cache_id: result.rows[0].id,
      file_id: file_id?.slice(0, 20) + '...',
      lat_ms: latency
    });
    
    return true;
  } catch (err) {
    console.error('[MEDIA][CACHE][UPDATE][ERR]', {
      bot_slug,
      sha256,
      kind,
      error: err.message
    });
    
    throw err;
  }
}

/**
 * Marca cache como erro após falha no warmup
 * @param {object} pool - Pool do PostgreSQL
 * @param {string} bot_slug - Slug do bot
 * @param {string} sha256 - Hash do conteúdo
 * @param {string} kind - Tipo
 * @param {string} errorMessage - Mensagem de erro
 * @returns {Promise<boolean>}
 */
async function markCacheError(pool, bot_slug, sha256, kind, errorMessage) {
  try {
    const query = `
      UPDATE media_cache
      SET 
        status = 'error',
        last_error = $1,
        updated_at = now()
      WHERE bot_slug = $2 AND sha256 = $3 AND kind = $4
      RETURNING id
    `;
    
    const result = await pool.query(query, [
      errorMessage,
      bot_slug,
      sha256,
      kind
    ]);
    
    observe('media_cache_errors_total', 1, { bot: bot_slug, kind });
    
    console.error('[MEDIA][CACHE][ERROR]', {
      bot_slug,
      sha256,
      kind,
      error: errorMessage
    });
    
    return result.rowCount > 0;
  } catch (err) {
    console.error('[MEDIA][CACHE][MARK_ERROR][ERR]', {
      bot_slug,
      sha256,
      kind,
      error: err.message
    });
    
    return false;
  }
}

/**
 * Lista todas as mídias de um bot
 * @param {object} pool - Pool do PostgreSQL
 * @param {string} bot_slug - Slug do bot
 * @param {object} filters - Filtros opcionais (kind, limit, offset)
 * @returns {Promise<Array>}
 */
async function listMedia(pool, bot_slug, filters = {}) {
  const { kind, limit = 50, offset = 0 } = filters;
  
  try {
    let query = `
      SELECT 
        ms.id,
        ms.bot_slug,
        ms.kind,
        ms.r2_key,
        ms.bytes,
        ms.sha256,
        ms.ext,
        ms.mime,
        ms.width,
        ms.height,
        ms.duration,
        ms.created_at,
        mc.tg_file_id,
        mc.status AS cache_status,
        mc.warmup_at,
        mc.last_error
      FROM media_store ms
      LEFT JOIN media_cache mc ON (
        ms.bot_slug = mc.bot_slug AND 
        ms.sha256 = mc.sha256 AND 
        ms.kind = mc.kind
      )
      WHERE ms.bot_slug = $1
    `;
    
    const params = [bot_slug];
    
    if (kind) {
      query += ` AND ms.kind = $${params.length + 1}`;
      params.push(kind);
    }
    
    query += ` ORDER BY ms.created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`;
    params.push(limit, offset);
    
    const result = await pool.query(query, params);
    
    return result.rows.map(row => ({
      id: row.id,
      bot_slug: row.bot_slug,
      kind: row.kind,
      r2_key: row.r2_key,
      bytes: row.bytes,
      sha256: row.sha256,
      ext: row.ext,
      mime: row.mime,
      width: row.width,
      height: row.height,
      duration: row.duration,
      created_at: row.created_at,
      cache: {
        file_id: row.tg_file_id,
        status: row.cache_status || 'not_cached',
        warmup_at: row.warmup_at,
        last_error: row.last_error
      }
    }));
  } catch (err) {
    console.error('[MEDIA][LIST][ERR]', {
      bot_slug,
      error: err.message
    });
    
    throw err;
  }
}

/**
 * Obtém detalhes de uma mídia específica
 * @param {object} pool - Pool do PostgreSQL
 * @param {number} mediaId - ID da mídia
 * @returns {Promise<object|null>}
 */
async function getMediaById(pool, mediaId) {
  try {
    const query = `
      SELECT 
        ms.*,
        mc.tg_file_id,
        mc.tg_file_unique_id,
        mc.status AS cache_status,
        mc.warmup_at,
        mc.warmup_chat_id,
        mc.warmup_message_id,
        mc.last_error
      FROM media_store ms
      LEFT JOIN media_cache mc ON (
        ms.bot_slug = mc.bot_slug AND 
        ms.sha256 = mc.sha256 AND 
        ms.kind = mc.kind
      )
      WHERE ms.id = $1
    `;
    
    const result = await pool.query(query, [mediaId]);
    
    if (result.rowCount === 0) {
      return null;
    }
    
    const row = result.rows[0];
    
    return {
      id: row.id,
      bot_slug: row.bot_slug,
      kind: row.kind,
      r2_key: row.r2_key,
      r2_etag: row.r2_etag,
      bytes: row.bytes,
      sha256: row.sha256,
      ext: row.ext,
      mime: row.mime,
      width: row.width,
      height: row.height,
      duration: row.duration,
      created_at: row.created_at,
      updated_at: row.updated_at,
      cache: {
        file_id: row.tg_file_id,
        file_unique_id: row.tg_file_unique_id,
        status: row.cache_status || 'not_cached',
        warmup_at: row.warmup_at,
        warmup_chat_id: row.warmup_chat_id,
        warmup_message_id: row.warmup_message_id,
        last_error: row.last_error
      }
    };
  } catch (err) {
    console.error('[MEDIA][GET_BY_ID][ERR]', {
      mediaId,
      error: err.message
    });
    
    throw err;
  }
}

module.exports = {
  saveMedia,
  getCachedFileId,
  createCacheEntry,
  updateCacheWithFileId,
  markCacheError,
  listMedia,
  getMediaById
};
