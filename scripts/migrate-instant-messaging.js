/* eslint-disable no-console */
require('dotenv').config();
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

async function run() {
  const cn = process.env.DATABASE_URL;
  if (!cn) {
    console.error('[MIGRATE] DATABASE_URL não definido');
    process.exit(2);
  }

  const client = new Client({ connectionString: cn, ssl: { rejectUnauthorized: false } });
  const t0 = Date.now();
  console.log('[MIGRATE][INSTANT-MESSAGING] start');

  try {
    await client.connect();
    console.log('[MIGRATE] Conectado ao banco');

    // Aplicar migrações na ordem
    const migrations = [
      '004_bot_messages.sql',
      '005_bot_downsells.sql',
      '006_shots.sql',
      '007_bot_start_message.sql'
    ];

    for (const migrationFile of migrations) {
      const filePath = path.join(__dirname, '..', 'migrations', migrationFile);
      
      if (!fs.existsSync(filePath)) {
        console.warn(`[MIGRATE] Arquivo não encontrado: ${migrationFile}`);
        continue;
      }

      console.log(`[MIGRATE] Aplicando ${migrationFile}...`);
      const sql = fs.readFileSync(filePath, 'utf8');
      
      try {
        await client.query(sql);
        console.log(`[MIGRATE] ✅ ${migrationFile} aplicado com sucesso`);
      } catch (err) {
        console.error(`[MIGRATE] ❌ Erro ao aplicar ${migrationFile}:`, err.message);
        throw err;
      }
    }

    console.log('[MIGRATE][INSTANT-MESSAGING] done in', Date.now() - t0, 'ms');
    process.exit(0);
  } catch (err) {
    console.error('[MIGRATE] error:', err && err.stack || err);
    process.exit(1);
  } finally {
    try { await client.end(); } catch {}
  }
}

run();
