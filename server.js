const express = require('express');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;
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

app.use((req, res) => {
  res.status(404).send('Not Found');
});

app.listen(port, () => {
  console.log(`Servidor ouvindo na porta ${port}`);
});
