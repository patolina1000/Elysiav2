require('dotenv').config();
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

/**
 * Executa migração 010 - Índices em deleted_at
 */
async function runMigration() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });

  try {
    await client.connect();
    console.log('🔌 Conectado ao banco de dados');

    console.log('📝 Executando migração 010_index_deleted_at.sql...');
    console.log('');

    // CREATE INDEX CONCURRENTLY deve ser executado fora de transaction block
    // Executar cada comando individualmente
    
    console.log('  Criando ix_bots_active_deleted_at...');
    await client.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_bots_active_deleted_at 
      ON public.bots(deleted_at, created_at DESC) 
      WHERE deleted_at IS NULL
    `);
    
    console.log('  Criando ix_bots_slug_not_deleted...');
    await client.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_bots_slug_not_deleted
      ON public.bots(slug)
      WHERE deleted_at IS NULL
    `);
    
    console.log('  Criando ix_bots_deleted_at_not_null...');
    await client.query(`
      CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_bots_deleted_at_not_null
      ON public.bots(deleted_at DESC)
      WHERE deleted_at IS NOT NULL
    `);
    
    console.log('  Executando ANALYZE...');
    await client.query('ANALYZE public.bots');

    console.log('');
    console.log('✅ Migração executada com sucesso!');
    console.log('');
    console.log('📊 Índices criados:');
    console.log('  - ix_bots_active_deleted_at (bots ativos)');
    console.log('  - ix_bots_slug_not_deleted (busca por slug)');
    console.log('  - ix_bots_deleted_at_not_null (bots deletados)');
    console.log('');
    console.log('🚀 Performance de listagem de bots melhorada!');

  } catch (err) {
    console.error('❌ Erro ao executar migração:', err.message);
    console.error('');
    console.error('Detalhes:', err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

runMigration();
