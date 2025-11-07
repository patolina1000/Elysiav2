const crypto = require('crypto');

function safeEqual(a, b) {
  const A = Buffer.from(String(a || ''), 'utf8');
  const B = Buffer.from(String(b || ''), 'utf8');
  if (A.length !== B.length) return false;
  try { return crypto.timingSafeEqual(A, B); } catch { return false; }
}

module.exports = function requireTgSecret(req, res, next) {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  
  // Secret obrigatório em produção (proteção contra webhooks falsos)
  if (!expected) {
    if (process.env.NODE_ENV === 'production') {
      console.error('[SECURITY][WEBHOOK_SECRET_NOT_SET]');
      return res.status(500).json({ 
        ok: false, 
        error: 'WEBHOOK_SECRET_NOT_CONFIGURED' 
      });
    }
    // Permitir apenas em dev/test para facilitar desenvolvimento local
    console.warn('[SECURITY][WEBHOOK_SECRET_MISSING][DEV_MODE]');
    return next();
  }

  const got = req.headers['x-telegram-bot-api-secret-token'] || '';
  if (!safeEqual(got, expected)) {
    return res.status(401).json({ ok: false, error: 'INVALID_TELEGRAM_SECRET' });
  }
  next();
};
