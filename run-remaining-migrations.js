require('dotenv').config();
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

async function run() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  
  await client.connect();
  
  const migrations = [
    '002_gateway_events_fix.sql',
    '003_funnel_events_dedup.sql',
    '004_bot_messages.sql',
    '006_shots.sql',
    '007_bot_start_message.sql'
  ];
  
  for (const file of migrations) {
    try {
      const sql = fs.readFileSync(path.join('./migrations', file), 'utf8');
      await client.query(sql);
      console.log(`✅ ${file}`);
    } catch (err) {
      console.log(`⚠️  ${file} - ${err.message.split('\n')[0]}`);
    }
  }
  
  await client.end();
  console.log('\n✅ Todas as migrações foram processadas');
}

run().catch(err => {
  console.error('❌ Erro:', err.message);
  process.exit(1);
});
