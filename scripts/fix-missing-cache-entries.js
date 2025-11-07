/**
 * Script para criar registros de cache para mídias existentes
 */

require('dotenv').config();
const { Pool } = require('pg');

async function fixMissingCacheEntries() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  
  try {
    console.log('\n🔧 Corrigindo registros de cache faltantes...\n');
    
    // Buscar todas as mídias que não têm cache
    const query = `
      SELECT ms.bot_slug, ms.sha256, ms.kind
      FROM media_store ms
      LEFT JOIN media_cache mc ON ms.bot_slug = mc.bot_slug 
        AND ms.sha256 = mc.sha256 
        AND ms.kind = mc.kind
      WHERE mc.id IS NULL
    `;
    
    const result = await pool.query(query);
    
    if (result.rowCount === 0) {
      console.log('✅ Nenhuma correção necessária. Todos os registros estão OK!\n');
      return;
    }
    
    console.log(`📋 Encontradas ${result.rowCount} mídias sem registro de cache\n`);
    
    // Criar registros de cache para cada mídia
    for (const row of result.rows) {
      const { bot_slug, sha256, kind } = row;
      
      const insertQuery = `
        INSERT INTO media_cache (bot_slug, sha256, kind, status)
        VALUES ($1, $2, $3, 'warming')
        ON CONFLICT (bot_slug, sha256, kind) DO NOTHING
      `;
      
      await pool.query(insertQuery, [bot_slug, sha256, kind]);
      
      console.log(`   ✅ ${kind}: ${sha256.slice(0, 16)}... (${bot_slug})`);
    }
    
    console.log(`\n🎉 ${result.rowCount} registros de cache criados com sucesso!`);
    console.log('\n💡 Próximo passo: Reaquecer as mídias via interface ou API\n');
    
  } catch (err) {
    console.error('\n❌ ERRO:', err.message);
    console.error('Stack:', err.stack);
  } finally {
    await pool.end();
  }
}

fixMissingCacheEntries();
