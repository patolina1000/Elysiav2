/**
 * Cloudflare R2 Storage Service
 * Implementa upload/download de mídia usando S3-compatible API
 * Usa undici para performance otimizada
 */

const crypto = require('crypto');
const { Readable } = require('stream');

// ========== UNDICI AGENT DEDICADO PARA R2 ==========

/**
 * Agent dedicado para R2 com configurações otimizadas
 * Separado do agent global para melhor isolamento e performance
 */
let r2Agent = null;

function getR2Agent() {
  if (!r2Agent) {
    try {
      const { Agent } = require('undici');
      r2Agent = new Agent({
        connections: 50,              // 50 conexões dedicadas para R2
        pipelining: 1,
        keepAliveTimeout: 120_000,    // 2 minutos (R2 permite conexões longas)
        keepAliveMaxTimeout: 180_000, // 3 minutos
        bodyTimeout: 60_000,          // 60s timeout para uploads/downloads grandes
        headersTimeout: 30_000        // 30s timeout para headers
      });
      console.info('[R2][AGENT] Agent dedicado criado com 50 conexões');
    } catch (err) {
      console.warn('[R2][AGENT] undici não disponível, usando fetch padrão');
    }
  }
  return r2Agent;
}

// ========== CACHE DE SIGNING KEY (AWS V4) ==========

/**
 * Cache de signing keys (válido por 1 dia)
 * Economiza 80-90% de CPU em operações crypto
 */
const signingKeyCache = new Map(); // dateStamp:region:service → {key, expires}
const SIGNING_KEY_TTL = 23 * 60 * 60 * 1000; // 23 horas

/**
 * Obtém ou calcula signing key com cache
 */
function getSigningKey(secretAccessKey, dateStamp, region, service) {
  const cacheKey = `${dateStamp}:${region}:${service}`;
  
  // Check cache
  const cached = signingKeyCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) {
    return cached.key;
  }
  
  // Calcular signing key (operação crypto intensiva)
  const kDate = crypto.createHmac('sha256', `AWS4${secretAccessKey}`).update(dateStamp).digest();
  const kRegion = crypto.createHmac('sha256', kDate).update(region).digest();
  const kService = crypto.createHmac('sha256', kRegion).update(service).digest();
  const kSigning = crypto.createHmac('sha256', kService).update('aws4_request').digest();
  
  // Cache com TTL de 23h
  signingKeyCache.set(cacheKey, {
    key: kSigning,
    expires: Date.now() + SIGNING_KEY_TTL
  });
  
  // Auto-cleanup após TTL
  setTimeout(() => {
    signingKeyCache.delete(cacheKey);
  }, SIGNING_KEY_TTL).unref();
  
  console.debug('[R2][SIGNING_KEY][CACHE_MISS]', { dateStamp, region, service });
  
  return kSigning;
}

// ========== CONFIGURAÇÃO ==========

/**
 * Configuração do R2 a partir de env vars
 */
function getR2Config() {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET || 'elysia-media';
  const publicBaseUrl = process.env.R2_PUBLIC_BASE_URL;

  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error('R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, and R2_SECRET_ACCESS_KEY are required');
  }

  // R2 endpoint: https://<account_id>.r2.cloudflarestorage.com
  const endpoint = `https://${accountId}.r2.cloudflarestorage.com`;

  return {
    accountId,
    accessKeyId,
    secretAccessKey,
    bucket,
    endpoint,
    publicBaseUrl
  };
}

/**
 * Gera assinatura AWS Signature V4 para requisições R2
 */
function signRequest(method, path, headers, payload, config) {
  const { accessKeyId, secretAccessKey } = config;
  const region = 'auto'; // R2 usa 'auto' como region
  const service = 's3';
  
  const now = new Date();
  const dateStamp = now.toISOString().slice(0, 10).replace(/-/g, '');
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  
  // Canonical request
  const payloadHash = crypto.createHash('sha256').update(payload || '').digest('hex');
  const canonicalHeaders = Object.keys(headers)
    .sort()
    .map(k => `${k.toLowerCase()}:${headers[k].trim()}\n`)
    .join('');
  const signedHeaders = Object.keys(headers).map(k => k.toLowerCase()).sort().join(';');
  
  const canonicalRequest = [
    method,
    path,
    '', // query string (vazio)
    canonicalHeaders,
    signedHeaders,
    payloadHash
  ].join('\n');
  
  // String to sign
  const algorithm = 'AWS4-HMAC-SHA256';
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const canonicalRequestHash = crypto.createHash('sha256').update(canonicalRequest).digest('hex');
  
  const stringToSign = [
    algorithm,
    amzDate,
    credentialScope,
    canonicalRequestHash
  ].join('\n');
  
  // Obter signing key (com cache - economiza 80-90% CPU)
  const kSigning = getSigningKey(secretAccessKey, dateStamp, region, service);
  
  // Signature
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  
  // Authorization header
  const authorization = `${algorithm} Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  
  return {
    ...headers,
    'x-amz-date': amzDate,
    'Authorization': authorization
  };
}

/**
 * Calcula SHA256 de um buffer
 */
function calculateSHA256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/**
 * Gera chave R2 baseada em bot_slug, tipo e hash
 */
function generateR2Key(bot_slug, kind, sha256, ext) {
  // Estrutura: bot_slug/kind/sha256.ext
  // Exemplo: mybot/photo/abc123def456.jpg
  const extension = ext ? `.${ext}` : '';
  return `${bot_slug}/${kind}/${sha256}${extension}`;
}

/**
 * Upload de arquivo para R2
 * @param {Buffer} buffer - Conteúdo do arquivo
 * @param {string} bot_slug - Slug do bot
 * @param {string} kind - Tipo de mídia (photo/video/document/audio)
 * @param {object} metadata - Metadados adicionais (mime, ext, width, height, duration)
 * @returns {Promise<object>} Resultado do upload
 */
async function uploadMedia(buffer, bot_slug, kind, metadata = {}) {
  const config = getR2Config();
  
  // Calcular SHA256 do conteúdo
  const sha256 = calculateSHA256(buffer);
  const { mime, ext, width, height, duration } = metadata;
  
  // Gerar chave R2
  const r2_key = generateR2Key(bot_slug, kind, sha256, ext);
  const path = `/${config.bucket}/${r2_key}`;
  
  // Headers
  const headers = {
    'Host': `${config.accountId}.r2.cloudflarestorage.com`,
    'Content-Type': mime || 'application/octet-stream',
    'Content-Length': buffer.length.toString(),
    'x-amz-content-sha256': sha256
  };
  
  // Adicionar metadados customizados
  if (width) headers['x-amz-meta-width'] = width.toString();
  if (height) headers['x-amz-meta-height'] = height.toString();
  if (duration) headers['x-amz-meta-duration'] = duration.toString();
  headers['x-amz-meta-bot-slug'] = bot_slug;
  headers['x-amz-meta-kind'] = kind;
  
  // Assinar requisição
  const signedHeaders = signRequest('PUT', path, headers, buffer, config);
  
  // Fazer upload
  const url = `${config.endpoint}${path}`;
  
  try {
    const agent = getR2Agent();
    const fetchOptions = {
      method: 'PUT',
      headers: signedHeaders,
      body: buffer
    };
    
    // Usar agent dedicado se disponível
    if (agent) {
      fetchOptions.dispatcher = agent;
    }
    
    const response = await fetch(url, fetchOptions);
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`R2 upload failed: ${response.status} ${errorText}`);
    }
    
    const etag = response.headers.get('etag');
    
    console.info('[R2][UPLOAD][OK]', {
      bot_slug,
      kind,
      r2_key,
      bytes: buffer.length,
      sha256,
      etag
    });
    
    return {
      ok: true,
      r2_key,
      sha256,
      bytes: buffer.length,
      etag,
      mime,
      ext,
      width,
      height,
      duration
    };
  } catch (err) {
    console.error('[R2][UPLOAD][ERR]', {
      bot_slug,
      kind,
      error: err.message
    });
    
    throw err;
  }
}

/**
 * Download de arquivo do R2
 * @param {string} r2_key - Chave do arquivo no R2
 * @returns {Promise<Buffer>} Conteúdo do arquivo
 */
async function downloadMedia(r2_key) {
  const config = getR2Config();
  const path = `/${config.bucket}/${r2_key}`;
  
  // Headers (incluir x-amz-content-sha256 para requisições GET)
  const headers = {
    'Host': `${config.accountId}.r2.cloudflarestorage.com`,
    'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' // SHA256 de string vazia
  };
  
  // Assinar requisição
  const signedHeaders = signRequest('GET', path, headers, '', config);
  
  // Fazer download
  const url = `${config.endpoint}${path}`;
  
  try {
    const agent = getR2Agent();
    const fetchOptions = {
      method: 'GET',
      headers: signedHeaders
    };
    
    // Usar agent dedicado se disponível
    if (agent) {
      fetchOptions.dispatcher = agent;
    }
    
    const response = await fetch(url, fetchOptions);
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`R2 download failed: ${response.status} ${errorText}`);
    }
    
    const buffer = Buffer.from(await response.arrayBuffer());
    
    console.info('[R2][DOWNLOAD][OK]', {
      r2_key,
      bytes: buffer.length
    });
    
    return buffer;
  } catch (err) {
    console.error('[R2][DOWNLOAD][ERR]', {
      r2_key,
      error: err.message
    });
    
    throw err;
  }
}

/**
 * Obtém URL pública de um arquivo (se R2_PUBLIC_BASE_URL estiver configurado)
 * @param {string} r2_key - Chave do arquivo no R2
 * @returns {string|null} URL pública ou null
 */
function getPublicUrl(r2_key) {
  const config = getR2Config();
  
  if (!config.publicBaseUrl) {
    return null;
  }
  
  return `${config.publicBaseUrl}/${r2_key}`;
}

/**
 * Deleta arquivo do R2
 * @param {string} r2_key - Chave do arquivo no R2
 * @returns {Promise<boolean>} true se deletado com sucesso
 */
async function deleteMedia(r2_key) {
  const config = getR2Config();
  const path = `/${config.bucket}/${r2_key}`;
  
  // Headers (incluir x-amz-content-sha256)
  const headers = {
    'Host': `${config.accountId}.r2.cloudflarestorage.com`,
    'x-amz-content-sha256': 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' // SHA256 de string vazia
  };
  
  // Assinar requisição
  const signedHeaders = signRequest('DELETE', path, headers, '', config);
  
  // Fazer delete
  const url = `${config.endpoint}${path}`;
  
  try {
    const agent = getR2Agent();
    const fetchOptions = {
      method: 'DELETE',
      headers: signedHeaders
    };
    
    // Usar agent dedicado se disponível
    if (agent) {
      fetchOptions.dispatcher = agent;
    }
    
    const response = await fetch(url, fetchOptions);
    
    if (!response.ok && response.status !== 404) {
      const errorText = await response.text();
      throw new Error(`R2 delete failed: ${response.status} ${errorText}`);
    }
    
    console.info('[R2][DELETE][OK]', { r2_key });
    return true;
  } catch (err) {
    console.error('[R2][DELETE][ERR]', {
      r2_key,
      error: err.message
    });
    
    throw err;
  }
}

/**
 * Verifica se R2 está configurado
 * @returns {boolean}
 */
function isR2Configured() {
  try {
    getR2Config();
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  uploadMedia,
  downloadMedia,
  deleteMedia,
  getPublicUrl,
  calculateSHA256,
  generateR2Key,
  isR2Configured
};
