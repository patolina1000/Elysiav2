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
  
  console.log('\n🔧 Aplicando migration 009_shots_v2.sql...\n');
  
  try {
    const migrationPath = path.join(__dirname, 'migrations', '009_shots_v2.sql');
    const sql = fs.readFileSync(migrationPath, 'utf8');
    
    await client.query(sql);
    
    console.log('✅ Migration 009_shots_v2.sql aplicada com sucesso!\n');
    
    // Verificar estrutura
    const result = await client.query(`
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'shots'
      ORDER BY ordinal_position
    `);
    
    console.log('📋 Estrutura da tabela shots:\n');
    result.rows.forEach(col => {
      console.log(`  - ${col.column_name} (${col.data_type}) ${col.is_nullable === 'NO' ? 'NOT NULL' : ''}`);
    });
    
    console.log('');
  } catch (err) {
    console.error('❌ Erro:', err.message);
    process.exit(1);
  }
  
  await client.end();
}

run().catch(err => {
  console.error('❌ Erro fatal:', err.message);
  process.exit(1);
});
