const crypto = require('crypto');
const tokenCache = require('./tokenCache');
const { warmUp } = require('./telegramClient');

/**
 * Serviço de criptografia e gerenciamento de tokens de bots
 * Usa AES-256-GCM (modo autenticado) para criptografia em repouso
 * Cache LRU em memória com TTL de 10 min
 */

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12; // 96 bits para GCM
const AUTH_TAG_LENGTH = 16; // 128 bits

/**
 * Mascara um token para logs (mostra apenas início e fim)
 * @param {string} token - Token a ser mascarado
 * @returns {string} Token mascarado
 */
function maskToken(token) {
  if (!token || typeof token !== 'string') return null;
  const s = String(token);
  if (s.length <= 8) return '***';
  return `${s.slice(0, 5)}...${s.slice(-3)}`;
}

/**
 * Valida se a ENCRYPTION_KEY está configurada
 * @returns {boolean}
 */
function hasEncryptionKey() {
  const key = process.env.ENCRYPTION_KEY;
  return !!(key && key.trim());
}

/**
 * Obtém a chave de criptografia do ambiente
 * @returns {Buffer} Chave de 32 bytes para AES-256
 * @throws {Error} Se ENCRYPTION_KEY não estiver configurada
 */
function getEncryptionKey() {
  const hex = process.env.ENCRYPTION_KEY || '';
  if (hex.length !== 64) {
    throw new Error('INVALID_ENCRYPTION_KEY_LENGTH'); // 32 bytes = 64 hex
  }
  return Buffer.from(hex, 'hex');
}

/**
 * Criptografa um token usando AES-256-GCM
 * @param {string} plainToken - Token em texto plano
 * @returns {{encrypted: string, iv: string}} Token criptografado e IV em base64
 * @throws {Error} Se ENCRYPTION_KEY não estiver configurada ou houver erro na criptografia
 */
function encryptToken(plainToken) {
  if (!plainToken || typeof plainToken !== 'string') {
    throw new Error('INVALID_TOKEN');
  }

  const key = getEncryptionKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  
  let encrypted = cipher.update(plainToken, 'utf8', 'base64');
  encrypted += cipher.final('base64');
  
  const authTag = cipher.getAuthTag();
  
  // Concatena encrypted + authTag
  const combined = Buffer.concat([
    Buffer.from(encrypted, 'base64'),
    authTag
  ]);
  
  return {
    encrypted: combined.toString('base64'),
    iv: iv.toString('base64')
  };
}

/**
 * Descriptografa um token usando AES-256-GCM
 * @param {string|Buffer} encryptedTokenB64 - Token criptografado em base64
 * @param {string|Buffer} ivB64 - IV em base64
 * @returns {string} Token em texto plano
 * @throws {Error} Se ENCRYPTION_KEY não estiver configurada ou houver erro na descriptografia
 */
function decryptToken(encryptedTokenB64, ivB64) {
  if (typeof encryptedTokenB64 !== 'string' || typeof ivB64 !== 'string') {
    throw new Error('INVALID_ENCRYPTED_DATA_TYPE');
  }

  // Remove espaços/quebras acidentais
  const encryptedClean = encryptedTokenB64.replace(/\s+/g, '').trim();
  const ivClean = ivB64.replace(/\s+/g, '').trim();

  const key = getEncryptionKey();
  const iv = Buffer.from(ivClean, 'base64');
  const combined = Buffer.from(encryptedClean, 'base64');

  if (iv.length !== 12) throw new Error('INVALID_IV_LENGTH');           // AES-GCM comum
  if (combined.length <= 16) throw new Error('INVALID_COMBINED_LENGTH'); // precisa ter cipher + tag(16)

  const authTag = combined.slice(-16);   // últimos 16 bytes = tag
  const encrypted = combined.slice(0, -16);

  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);

  const out = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return out.toString('utf8');
}

/**
 * Salva um token criptografado para um bot (por slug)
 * @param {object} pool - Pool de conexão PostgreSQL
 * @param {string} slug - Slug do bot
 * @param {string} plainToken - Token em texto plano
 * @returns {Promise<{ok: boolean, has_token: boolean, token_masked: string, token_updated_at: string}>}
 */
async function saveTokenBySlug(pool, slug, plainToken) {
  const startTime = Date.now();
  
  if (!pool) {
    throw new Error('DATABASE_NOT_AVAILABLE');
  }
  
  if (!slug || typeof slug !== 'string') {
    throw new Error('INVALID_SLUG');
  }
  
  if (!plainToken || typeof plainToken !== 'string' || !plainToken.trim()) {
    throw new Error('MISSING_TOKEN');
  }
  
  if (!hasEncryptionKey()) {
    throw new Error('ENCRYPTION_KEY_NOT_SET');
  }
  
  const { encrypted, iv } = encryptToken(plainToken.trim());
  const now = new Date();
  
  const query = `
    UPDATE public.bots
    SET token_encrypted = $1,
        token_iv = $2,
        token_updated_at = $3
    WHERE slug = $4
    RETURNING slug, token_updated_at
  `;
  
  const result = await pool.query(query, [encrypted, iv, now, slug]);
  
  if (result.rowCount === 0) {
    throw new Error('BOT_NOT_FOUND');
  }
  
  const row = result.rows[0];
  const latency = Date.now() - startTime;
  
  // Atualizar cache
  tokenCache.set(slug, plainToken.trim(), row.token_updated_at);
  
  // Warm-up assíncrono (não bloqueia)
  setImmediate(() => {
    warmUp(plainToken.trim()).catch(err => {
      console.warn('[TOKEN_SERVICE][WARMUP][ERR]', { slug, error: err.message });
    });
  });
  
  console.info('[TOKEN_SERVICE][SAVE]', {
    slug,
    token_masked: maskToken(plainToken),
    token_updated_at: row.token_updated_at,
    latency_ms: latency
  });
  
  return {
    ok: true,
    has_token: true,
    token_masked: maskToken(plainToken),
    token_updated_at: row.token_updated_at
  };
}

/**
 * Obtém o token descriptografado de um bot (para uso interno)
 * @param {object} pool - Pool de conexão PostgreSQL
 * @param {string} slug - Slug do bot
 * @returns {Promise<string|null>} Token em texto plano ou null se não existir
 */
async function getTokenBySlug(pool, slug) {
  const startTime = Date.now();
  
  if (!pool) {
    throw new Error('DATABASE_NOT_AVAILABLE');
  }
  
  if (!slug || typeof slug !== 'string') {
    throw new Error('INVALID_SLUG');
  }
  
  // Tentar cache primeiro
  const cached = tokenCache.get(slug);
  const cachedEntry = cached ? tokenCache.cache.get(slug) : null;
  
  // Cache miss - buscar do banco
  const query = `
    SELECT token_encrypted, token_iv, token_updated_at
    FROM public.bots
    WHERE slug = $1
  `;
  
  const result = await pool.query(query, [slug]);
  
  // Verificar se cache ainda é válido (previne race condition)
  // Se token foi atualizado no banco após timestamp do cache, invalidar cache
  if (cached && cachedEntry && result.rows[0]?.token_updated_at) {
    const dbUpdatedAt = new Date(result.rows[0].token_updated_at).getTime();
    const cacheUpdatedAt = new Date(cachedEntry.updatedAt).getTime();
    
    if (dbUpdatedAt > cacheUpdatedAt) {
      // Token foi atualizado no banco, cache está desatualizado
      console.warn('[TOKEN_SERVICE][CACHE_STALE]', {
        slug,
        cache_updated_at: cachedEntry.updatedAt,
        db_updated_at: result.rows[0].token_updated_at
      });
      // Continue para reprocessar token do banco
    } else {
      // Cache ainda é válido
      const latency = Date.now() - startTime;
      console.info('[TOKEN_SERVICE][GET][CACHE_HIT]', {
        slug,
        token_masked: maskToken(cached),
        latency_ms: latency
      });
      return cached;
    }
  }
  
  if (result.rowCount === 0) {
    throw new Error('BOT_NOT_FOUND');
  }
  
  const row = result.rows[0];
  
  if (!row.token_encrypted || !row.token_iv) {
    const latency = Date.now() - startTime;
    console.info('[TOKEN_SERVICE][GET]', {
      slug,
      has_token: false,
      latency_ms: latency
    });
    return null;
  }
  
  if (!hasEncryptionKey()) {
    throw new Error('ENCRYPTION_KEY_NOT_SET');
  }
  
  try {
    // Normaliza para string base64 "limpa"
    const encRaw = row.token_encrypted;
    const ivRaw = row.token_iv;
    
    const encB64 = Buffer.isBuffer(encRaw) ? encRaw.toString('utf8') : String(encRaw || '');
    const ivB64 = Buffer.isBuffer(ivRaw) ? ivRaw.toString('utf8') : String(ivRaw || '');
    const enc = encB64.replace(/\s+/g, '').trim();
    const iv = ivB64.replace(/\s+/g, '').trim();
    
    // Validações amigáveis (falham "bonito" antes do crypto)
    if (!enc || !iv) throw new Error('ENCRYPTED_DATA_MISSING');
    if (Buffer.from(iv, 'base64').length !== 12) throw new Error('INVALID_IV_LENGTH');
    
    const plainToken = decryptToken(enc, iv);
    const latency = Date.now() - startTime;
    
    // Preencher cache
    tokenCache.set(slug, plainToken, row.token_updated_at);
    
    console.info('[TOKEN_SERVICE][GET][CACHE_MISS]', {
      slug,
      token_masked: maskToken(plainToken),
      has_token: true,
      latency_ms: latency
    });
    
    return plainToken;
  } catch (err) {
    // Log defensivo para debug
    console.error('[TOKEN][DECRYPT][ERR]', {
      slug,
      code: err.code || err.message,
      ivLen: row?.token_iv ? Buffer.from(String(row.token_iv).trim(), 'base64').length : null,
      encLen: row?.token_encrypted ? Buffer.from(String(row.token_encrypted).trim(), 'base64').length : null,
    });
    throw err;
  }
}

/**
 * Verifica se um bot tem token configurado
 * @param {object} pool - Pool de conexão PostgreSQL
 * @param {string} slug - Slug do bot
 * @returns {Promise<boolean>}
 */
async function hasToken(pool, slug) {
  if (!pool) {
    throw new Error('DATABASE_NOT_AVAILABLE');
  }
  
  if (!slug || typeof slug !== 'string') {
    throw new Error('INVALID_SLUG');
  }
  
  const query = `
    SELECT (token_encrypted IS NOT NULL AND token_iv IS NOT NULL) AS has_token
    FROM public.bots
    WHERE slug = $1
  `;
  
  const result = await pool.query(query, [slug]);
  
  if (result.rowCount === 0) {
    throw new Error('BOT_NOT_FOUND');
  }
  
  return result.rows[0].has_token;
}

module.exports = {
  maskToken,
  hasEncryptionKey,
  encryptToken,
  decryptToken,
  saveTokenBySlug,
  getTokenBySlug,
  hasToken
};
