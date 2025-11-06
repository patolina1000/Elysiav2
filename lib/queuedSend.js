/**
 * Wrapper para envio com fila e prioridades
 * Não altera a função de envio real, apenas a enfileira
 */

const config = require('../config/rate');
const { enqueue } = require('./queueManager');
const { sendMessage: sendMessageDirect } = require('./sendService');
const { observe } = require('./metricsService');

/**
 * Enviar mensagem através da fila com prioridade
 */
async function sendMessage(pool, params) {
  const { purpose = 'send-test', chat_id, slug } = params;
  const queuedAt = Date.now();
  
  // Determinar prioridade baseado no purpose
  let priority;
  if (purpose === 'start') {
    priority = config.PRIORITY.START;
  } else if (purpose === 'disparo' || purpose === 'shot') {
    priority = config.PRIORITY.DISPARO;
  } else if (purpose === 'downsell') {
    priority = config.PRIORITY.DOWNSELL;
  } else {
    // Default: disparo
    priority = config.PRIORITY.DISPARO;
  }
  
  // Criar callback que executa o envio real
  const callback = async () => {
    const sendStart = Date.now();
    const queueWaitMs = sendStart - queuedAt;
    
    // Observar tempo de espera na fila
    observe('queue_wait_ms', queueWaitMs, { priority, purpose, bot: slug });
    
    // Executar envio real (função original)
    const result = await sendMessageDirect(pool, params);
    
    // Adicionar métricas de fila ao resultado
    result.queue_wait_ms = queueWaitMs;
    result.priority = priority;
    
    // Observar métricas de envio
    if (result.ok) {
      observe('send_attempt_ms', result.lat_ms, { priority, purpose, bot: slug, chat_id });
      if (result.telegram_lat_ms) {
        observe('telegram_http_ms', result.telegram_lat_ms, { priority, purpose, bot: slug });
      }
    }
    
    return result;
  };
  
  // Enfileirar
  return new Promise((resolve, reject) => {
    enqueue(priority, String(chat_id), async () => {
      try {
        const result = await callback();
        resolve(result);
        return result;
      } catch (err) {
        reject(err);
        throw err;
      }
    }, {
      purpose,
      slug,
      queuedAt
    });
  });
}

/**
 * Obter métricas da fila
 */
function getQueueMetrics() {
  const { getMetrics } = require('./queueManager');
  return getMetrics();
}

module.exports = {
  sendMessage,
  getQueueMetrics
};
