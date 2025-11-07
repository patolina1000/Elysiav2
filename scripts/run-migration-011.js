/**
 * Executa migração 011 - Sistema de Mídia
 */

require('dotenv').config();
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

async function runMigration() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  
  try {
    console.log('[MIGRATION_011] Iniciando...');
    
    // Ler arquivo de migração
    const migrationPath = path.join(__dirname, '..', 'migrations', '011_media_system.sql');
    const sql = fs.readFileSync(migrationPath, 'utf-8');
    
    console.log('[MIGRATION_011] Executando SQL...');
    
    // Executar migração
    await pool.query(sql);
    
    console.log('[MIGRATION_011] ✅ Concluída com sucesso!');
    
    // Verificar tabelas criadas
    const checkQuery = `
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
        AND table_name IN ('media_store', 'media_cache')
      ORDER BY table_name
    `;
    
    const result = await pool.query(checkQuery);
    console.log('[MIGRATION_011] Tabelas criadas:', result.rows.map(r => r.table_name));
    
    // Verificar coluna warmup_chat_id
    const columnCheck = `
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_schema = 'public' 
        AND table_name = 'bots' 
        AND column_name = 'warmup_chat_id'
    `;
    
    const columnResult = await pool.query(columnCheck);
    if (columnResult.rowCount > 0) {
      console.log('[MIGRATION_011] ✅ Coluna warmup_chat_id adicionada à tabela bots');
    }
    
  } catch (err) {
    console.error('[MIGRATION_011] ❌ ERRO:', err.message);
    console.error('Stack:', err.stack);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

runMigration();
