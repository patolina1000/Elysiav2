/**
 * Executa migração 012 - Suporte a Mídia em bot_messages
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
    console.log('[MIGRATION_012] Iniciando...');
    
    // Ler arquivo de migração
    const migrationPath = path.join(__dirname, '..', 'migrations', '012_bot_messages_media.sql');
    const sql = fs.readFileSync(migrationPath, 'utf-8');
    
    console.log('[MIGRATION_012] Executando SQL...');
    
    // Executar migração
    await pool.query(sql);
    
    console.log('[MIGRATION_012] ✅ Concluída com sucesso!');
    
    // Verificar colunas criadas
    const checkQuery = `
      SELECT column_name, data_type
      FROM information_schema.columns 
      WHERE table_schema = 'public' 
        AND table_name = 'bot_messages'
        AND column_name IN ('media_sha256', 'media_kind', 'media_r2_key')
      ORDER BY column_name
    `;
    
    const result = await pool.query(checkQuery);
    console.log('[MIGRATION_012] Colunas criadas:');
    result.rows.forEach(r => {
      console.log(`   ✅ ${r.column_name} (${r.data_type})`);
    });
    
    // Verificar view criada
    const viewCheck = `
      SELECT table_name 
      FROM information_schema.views 
      WHERE table_schema = 'public' 
        AND table_name = 'bot_messages_with_media'
    `;
    
    const viewResult = await pool.query(viewCheck);
    if (viewResult.rowCount > 0) {
      console.log('[MIGRATION_012] ✅ View bot_messages_with_media criada');
    }
    
    // Verificar trigger
    const triggerCheck = `
      SELECT trigger_name 
      FROM information_schema.triggers 
      WHERE event_object_table = 'bot_messages' 
        AND trigger_name = 'trg_validate_bot_message_media'
    `;
    
    const triggerResult = await pool.query(triggerCheck);
    if (triggerResult.rowCount > 0) {
      console.log('[MIGRATION_012] ✅ Trigger de validação criado');
    }
    
    console.log('\n[MIGRATION_012] 🎉 Sistema pronto para mensagens com mídia!');
    
  } catch (err) {
    console.error('[MIGRATION_012] ❌ ERRO:', err.message);
    console.error('Stack:', err.stack);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

runMigration();
