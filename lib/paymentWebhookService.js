/**
 * Serviço para processar webhooks de pagamento
 * Gerencia agendamento de downsells após PIX e cancelamento ao pagar
 */

const { scheduleDownsellsForPix, cancelDownsellsOnPayment, cancelDownsellsOnExpiration } = require('./downsellService');
const { observe } = require('./metricsService');

/**
 * Processa webhook de PIX criado
 * @param {object} pool - Pool PostgreSQL
 * @param {object} params - { bot_slug, telegram_id, transaction_id, correlation_id }
 */
async function handlePixCreated(pool, params) {
  const { bot_slug, telegram_id, transaction_id, correlation_id } = params;

  if (!pool || !bot_slug || !telegram_id || !transaction_id) {
    console.warn('[PAYMENT_WEBHOOK][PIX_CREATED][INVALID_PARAMS]', params);
    return { ok: false, reason: 'invalid_params' };
  }

  try {
    // Agendar downsells com gatilho PIX
    const scheduled = await scheduleDownsellsForPix(pool, {
      bot_slug,
      telegram_id,
      transaction_id,
      correlation_id,
      now: new Date()
    });

    console.info('[PAYMENT_WEBHOOK][PIX_CREATED][OK]', {
      bot_slug,
      telegram_id,
      transaction_id,
      scheduled
    });

    return { ok: true, scheduled };
  } catch (err) {
    console.error('[PAYMENT_WEBHOOK][PIX_CREATED][ERR]', {
      bot_slug,
      telegram_id,
      transaction_id,
      error: err.message
    });
    return { ok: false, error: err.message };
  }
}

/**
 * Processa webhook de pagamento aprovado
 * @param {object} pool - Pool PostgreSQL
 * @param {object} params - { bot_slug, telegram_id, transaction_id }
 */
async function handlePaymentApproved(pool, params) {
  const { bot_slug, telegram_id, transaction_id } = params;

  if (!pool || !bot_slug || !telegram_id || !transaction_id) {
    console.warn('[PAYMENT_WEBHOOK][PAYMENT_APPROVED][INVALID_PARAMS]', params);
    return { ok: false, reason: 'invalid_params' };
  }

  try {
    // Cancelar todos os downsells pendentes do usuário
    const canceled = await cancelDownsellsOnPayment(pool, {
      bot_slug,
      telegram_id,
      transaction_id
    });

    console.info('[PAYMENT_WEBHOOK][PAYMENT_APPROVED][OK]', {
      bot_slug,
      telegram_id,
      transaction_id,
      canceled
    });

    return { ok: true, canceled };
  } catch (err) {
    console.error('[PAYMENT_WEBHOOK][PAYMENT_APPROVED][ERR]', {
      bot_slug,
      telegram_id,
      transaction_id,
      error: err.message
    });
    return { ok: false, error: err.message };
  }
}

/**
 * Processa webhook de PIX expirado
 * @param {object} pool - Pool PostgreSQL
 * @param {object} params - { transaction_id }
 */
async function handlePixExpired(pool, params) {
  const { transaction_id } = params;

  if (!pool || !transaction_id) {
    console.warn('[PAYMENT_WEBHOOK][PIX_EXPIRED][INVALID_PARAMS]', params);
    return { ok: false, reason: 'invalid_params' };
  }

  try {
    // Cancelar downsells pendentes da transação expirada
    const canceled = await cancelDownsellsOnExpiration(pool, transaction_id);

    console.info('[PAYMENT_WEBHOOK][PIX_EXPIRED][OK]', {
      transaction_id,
      canceled
    });

    return { ok: true, canceled };
  } catch (err) {
    console.error('[PAYMENT_WEBHOOK][PIX_EXPIRED][ERR]', {
      transaction_id,
      error: err.message
    });
    return { ok: false, error: err.message };
  }
}

module.exports = {
  handlePixCreated,
  handlePaymentApproved,
  handlePixExpired
};
