/**
 * Serviço de elegibilidade para downsells baseados em PIX
 * Verifica se o usuário tem PIX não pago e vigente
 */

/**
 * Verifica se uma transação específica está elegível (PIX não pago)
 * @param {object} pool - Pool PostgreSQL
 * @param {string} transaction_id - ID da transação
 * @returns {Promise<boolean>} true se elegível (PIX não pago)
 */
async function isTransactionEligible(pool, transaction_id) {
  if (!pool || !transaction_id) return false;

  try {
    // Busca evento de PIX criado e verifica se não foi pago
    // Assumindo que funnel_events registra 'pix_created' e 'payment_approved'
    const query = `
      SELECT 
        COUNT(*) FILTER (WHERE event_name = 'pix_created') as created_count,
        COUNT(*) FILTER (WHERE event_name = 'payment_approved') as paid_count
      FROM public.funnel_events
      WHERE transaction_id = $1
    `;
    
    const result = await pool.query(query, [transaction_id]);
    const row = result.rows[0];
    
    // Elegível se foi criado mas não foi pago
    const eligible = row.created_count > 0 && row.paid_count === 0;
    
    return eligible;
  } catch (err) {
    console.error('[PIX_ELIGIBILITY][TX_CHECK][ERR]', { 
      transaction_id, 
      error: err.message 
    });
    return false;
  }
}

/**
 * Verifica se um usuário tem algum PIX não pago vigente
 * @param {object} pool - Pool PostgreSQL
 * @param {string} bot_slug - Slug do bot
 * @param {number} telegram_id - ID do usuário no Telegram
 * @returns {Promise<boolean>} true se tem PIX não pago
 */
async function hasUnpaidPix(pool, bot_slug, telegram_id) {
  if (!pool || !bot_slug || !telegram_id) return false;

  try {
    // Busca PIX criados e não pagos para o usuário
    // Considera apenas PIX dos últimos 7 dias (para evitar PIX muito antigos)
    const query = `
      WITH pix_created AS (
        SELECT DISTINCT transaction_id
        FROM public.funnel_events
        WHERE bot_slug = $1 
          AND tg_id = $2
          AND event_name = 'pix_created'
          AND occurred_at > now() - interval '7 days'
      ),
      pix_paid AS (
        SELECT DISTINCT transaction_id
        FROM public.funnel_events
        WHERE bot_slug = $1 
          AND tg_id = $2
          AND event_name = 'payment_approved'
      )
      SELECT COUNT(*) as unpaid_count
      FROM pix_created pc
      WHERE NOT EXISTS (
        SELECT 1 FROM pix_paid pp 
        WHERE pp.transaction_id = pc.transaction_id
      )
    `;
    
    const result = await pool.query(query, [bot_slug, telegram_id]);
    const unpaid_count = parseInt(result.rows[0]?.unpaid_count || 0, 10);
    
    return unpaid_count > 0;
  } catch (err) {
    console.error('[PIX_ELIGIBILITY][USER_CHECK][ERR]', { 
      bot_slug, 
      telegram_id, 
      error: err.message 
    });
    return false;
  }
}

/**
 * Obtém o PIX mais recente não pago de um usuário
 * @param {object} pool - Pool PostgreSQL
 * @param {string} bot_slug - Slug do bot
 * @param {number} telegram_id - ID do usuário no Telegram
 * @returns {Promise<string|null>} transaction_id ou null
 */
async function getLatestUnpaidPix(pool, bot_slug, telegram_id) {
  if (!pool || !bot_slug || !telegram_id) return null;

  try {
    const query = `
      WITH pix_created AS (
        SELECT transaction_id, occurred_at
        FROM public.funnel_events
        WHERE bot_slug = $1 
          AND tg_id = $2
          AND event_name = 'pix_created'
          AND occurred_at > now() - interval '7 days'
        ORDER BY occurred_at DESC
      ),
      pix_paid AS (
        SELECT DISTINCT transaction_id
        FROM public.funnel_events
        WHERE bot_slug = $1 
          AND tg_id = $2
          AND event_name = 'payment_approved'
      )
      SELECT pc.transaction_id
      FROM pix_created pc
      WHERE NOT EXISTS (
        SELECT 1 FROM pix_paid pp 
        WHERE pp.transaction_id = pc.transaction_id
      )
      LIMIT 1
    `;
    
    const result = await pool.query(query, [bot_slug, telegram_id]);
    return result.rows[0]?.transaction_id || null;
  } catch (err) {
    console.error('[PIX_ELIGIBILITY][LATEST_PIX][ERR]', { 
      bot_slug, 
      telegram_id, 
      error: err.message 
    });
    return null;
  }
}

/**
 * Verifica elegibilidade para envio de downsell
 * @param {object} pool - Pool PostgreSQL
 * @param {object} params - { trigger, transaction_id, bot_slug, telegram_id }
 * @returns {Promise<{eligible: boolean, reason?: string}>}
 */
async function checkDownsellEligibility(pool, params) {
  const { trigger, transaction_id, bot_slug, telegram_id } = params;

  if (!pool) {
    return { eligible: false, reason: 'no_database' };
  }

  try {
    if (trigger === 'pix') {
      // Para gatilho PIX, verifica a transação específica
      if (!transaction_id) {
        return { eligible: false, reason: 'no_transaction_id' };
      }
      
      const eligible = await isTransactionEligible(pool, transaction_id);
      return { 
        eligible, 
        reason: eligible ? undefined : 'no_unpaid_pix' 
      };
    } else if (trigger === 'start') {
      // Para gatilho START, verifica se usuário tem algum PIX não pago
      if (!bot_slug || !telegram_id) {
        return { eligible: false, reason: 'missing_params' };
      }
      
      const eligible = await hasUnpaidPix(pool, bot_slug, telegram_id);
      return { 
        eligible, 
        reason: eligible ? undefined : 'no_unpaid_pix' 
      };
    }
    
    return { eligible: false, reason: 'invalid_trigger' };
  } catch (err) {
    console.error('[PIX_ELIGIBILITY][CHECK][ERR]', { 
      params, 
      error: err.message 
    });
    return { eligible: false, reason: 'check_error' };
  }
}

module.exports = {
  isTransactionEligible,
  hasUnpaidPix,
  getLatestUnpaidPix,
  checkDownsellEligibility
};
