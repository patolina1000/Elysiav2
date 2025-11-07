// Script temporário para capturar logs de boot
const originalLog = console.log;
const originalInfo = console.info;
const originalWarn = console.warn;
const originalError = console.error;

const logs = [];

console.log = (...args) => {
  logs.push(['LOG', ...args]);
  originalLog(...args);
};

console.info = (...args) => {
  logs.push(['INFO', ...args]);
  originalInfo(...args);
};

console.warn = (...args) => {
  logs.push(['WARN', ...args]);
  originalWarn(...args);
};

console.error = (...args) => {
  logs.push(['ERROR', ...args]);
  originalError(...args);
};

// Aguardar boot e então salvar logs
setTimeout(() => {
  const fs = require('fs');
  fs.writeFileSync('boot-logs.txt', logs.map(l => l.join(' ')).join('\n'), 'utf-8');
  console.log('[TEST] Logs salvos em boot-logs.txt');
  setTimeout(() => process.exit(0), 1000);
}, 8000);

// Executar servidor
require('./server.js');
