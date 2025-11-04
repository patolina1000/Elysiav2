const crypto = require('crypto');

function safeEqual(a, b) {
  const A = Buffer.from(String(a || ''), 'utf8');
  const B = Buffer.from(String(b || ''), 'utf8');
  if (A.length !== B.length) return false;
  try { return crypto.timingSafeEqual(A, B); } catch { return false; }
}

module.exports = function requireAdmin(req, res, next) {
  const expected = process.env.ADMIN_API_TOKEN;

  // Falha de config: não permitir acesso sem token configurado
  if (!expected) {
    return res.status(500).json({ ok: false, error: 'ADMIN_API_TOKEN_NOT_SET' });
  }

  const auth = req.headers['authorization'] || '';
  const [scheme, token] = auth.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token || !safeEqual(token, expected)) {
    // Não logar token; manter resposta seca
    return res.status(401).json({ ok: false, error: 'UNAUTHORIZED' });
  }

  return next();
};
