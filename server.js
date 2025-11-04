const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const publicDirectory = path.join(__dirname, 'public');

app.use(express.json());

app.post('/api/telegram/validate-token', async (req, res) => {
  const token = typeof req.body?.token === 'string' ? req.body.token.trim() : '';
  if (!token) {
    return res.status(400).json({ ok: false, error: 'TOKEN_REQUIRED' });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  const url = `https://api.telegram.org/bot${encodeURIComponent(token)}/getMe`;

  try {
    const response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    const data = await response.json().catch(() => ({}));
    if (data && data.ok) {
      const { id, username, first_name } = data.result || {};
      return res.json({ ok: true, result: { id, username, first_name } });
    }
    const reason = (data && (data.description || data.error)) || 'INVALID_TOKEN';
    return res.status(400).json({ ok: false, error: reason });
  } catch (error) {
    clearTimeout(timeout);
    const message = error && error.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK';
    return res.status(502).json({ ok: false, error: message });
  }
});

app.use(express.static(publicDirectory, {
  extensions: ['html'],
  fallthrough: true
}));

app.get('/env.js', (_req, res) => {
  const appBaseUrl = process.env.APP_BASE_URL || '';
  const publicBaseUrl = process.env.PUBLIC_BASE_URL || '';

  res.type('application/javascript');
  res.send(`window.__ENV__ = Object.freeze({\n` +
    `  APP_BASE_URL: ${JSON.stringify(appBaseUrl)},\n` +
    `  PUBLIC_BASE_URL: ${JSON.stringify(publicBaseUrl)}\n` +
    `});\n`);
});

app.use((req, res, next) => {
  if (req.method === 'GET' && !req.path.includes('.')) {
    res.sendFile(path.join(publicDirectory, 'index.html'), (err) => {
      if (err) {
        next();
      }
    });
  } else {
    next();
  }
});

// ---- Health check para o Render (retorna 200 OK) ----
// Mantém resposta em texto simples para ser leve e previsível.
// Adicionar ANTES do app.listen(...)
app.get('/healthz', (_req, res) => {
  res.status(200).type('text/plain').send('ok');
});
// Alguns provedores usam HEAD no healthcheck; garanta 200 também:
app.head('/healthz', (_req, res) => res.sendStatus(200));

app.use((req, res) => {
  res.status(404).send('Not Found');
});

const HOST = '0.0.0.0';
app.listen(PORT, HOST, () => {
  console.log(`Servidor ouvindo na porta ${PORT}`);
});
