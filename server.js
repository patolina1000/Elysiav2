const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const publicDirectory = path.join(__dirname, 'public');

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
