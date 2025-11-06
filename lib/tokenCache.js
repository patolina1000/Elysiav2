/**
 * Cache LRU em memória para tokens descriptografados
 * TTL de 10 minutos para reduzir latência de leitura do banco
 */

const TTL_MS = 10 * 60 * 1000; // 10 minutos

class TokenCache {
  constructor() {
    this.cache = new Map(); // slug -> { token, iv, updatedAt, cachedAt }
    this.accessOrder = []; // LRU tracking
    this.maxSize = 100;
  }

  /**
   * Obtém token do cache
   * @param {string} slug
   * @returns {string|null} Token descriptografado ou null se não estiver no cache
   */
  get(slug) {
    const entry = this.cache.get(slug);
    
    if (!entry) {
      return null;
    }
    
    // Verificar TTL
    const age = Date.now() - entry.cachedAt;
    if (age > TTL_MS) {
      this.cache.delete(slug);
      this._removeFromAccessOrder(slug);
      return null;
    }
    
    // Atualizar LRU
    this._touch(slug);
    
    return entry.token;
  }

  /**
   * Armazena token no cache
   * @param {string} slug
   * @param {string} token - Token descriptografado
   * @param {Date} updatedAt - Data de atualização do token
   */
  set(slug, token, updatedAt) {
    // Evitar cache overflow
    if (this.cache.size >= this.maxSize && !this.cache.has(slug)) {
      const oldest = this.accessOrder.shift();
      if (oldest) {
        this.cache.delete(oldest);
      }
    }
    
    this.cache.set(slug, {
      token,
      updatedAt,
      cachedAt: Date.now()
    });
    
    this._touch(slug);
  }

  /**
   * Invalida entrada do cache
   * @param {string} slug
   */
  invalidate(slug) {
    this.cache.delete(slug);
    this._removeFromAccessOrder(slug);
  }

  /**
   * Limpa todo o cache
   */
  clear() {
    this.cache.clear();
    this.accessOrder = [];
  }

  /**
   * Atualiza ordem de acesso (LRU)
   */
  _touch(slug) {
    this._removeFromAccessOrder(slug);
    this.accessOrder.push(slug);
  }

  /**
   * Remove slug da ordem de acesso
   */
  _removeFromAccessOrder(slug) {
    const index = this.accessOrder.indexOf(slug);
    if (index > -1) {
      this.accessOrder.splice(index, 1);
    }
  }

  /**
   * Obtém estatísticas do cache
   */
  getStats() {
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      ttl_ms: TTL_MS
    };
  }
}

// Singleton
const tokenCache = new TokenCache();

module.exports = tokenCache;
