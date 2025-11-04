const crypto = require('crypto');

function safeEqual(a, b) {
  const A = Buffer.from(String(a || ''), 'utf8');
  const B = Buffer.from(String(b || ''), 'utf8');
  if (A.length !== B.length) return false;
  try { return crypto.timingSafeEqual(A, B); } catch { return false; }
}

module.exports = function requireTgSecret(req, res, next) {
  const expected = process.env.TELEGRAM_WEBHOOK_SECRET;
  // Se não houver secret configurado, não bloqueia (facilita testes locais)
  if (!expected) return next();

  const got = req.headers['x-telegram-bot-api-secret-token'] || '';
  if (!safeEqual(got, expected)) {
    return res.status(401).json({ ok: false, error: 'INVALID_TELEGRAM_SECRET' });
  }
  next();
};
