// Verificar se tabelas de mídia existem
require('dotenv').config();
const { Pool } = require('pg');

async function checkTables() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  
  try {
    // Verificar tabelas
    const tablesQuery = `
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
        AND table_name IN ('media_store', 'media_cache')
      ORDER BY table_name
    `;
    
    const tablesResult = await pool.query(tablesQuery);
    console.log('\n=== TABELAS DE MÍDIA ===');
    console.log('Encontradas:', tablesResult.rows.map(r => r.table_name));
    
    // Verificar coluna warmup_chat_id em bots
    const columnQuery = `
      SELECT column_name, data_type 
      FROM information_schema.columns 
      WHERE table_schema = 'public' 
        AND table_name = 'bots' 
        AND column_name = 'warmup_chat_id'
    `;
    
    const columnResult = await pool.query(columnQuery);
    console.log('\n=== COLUNA warmup_chat_id ===');
    if (columnResult.rowCount > 0) {
      console.log('✅ Existe:', columnResult.rows[0]);
    } else {
      console.log('❌ NÃO existe');
    }
    
    // Se media_store existe, verificar estrutura
    if (tablesResult.rows.some(r => r.table_name === 'media_store')) {
      const structureQuery = `
        SELECT column_name, data_type, is_nullable
        FROM information_schema.columns 
        WHERE table_schema = 'public' 
          AND table_name = 'media_store'
        ORDER BY ordinal_position
      `;
      
      const structureResult = await pool.query(structureQuery);
      console.log('\n=== ESTRUTURA media_store ===');
      structureResult.rows.forEach(r => {
        console.log(`- ${r.column_name}: ${r.data_type} (nullable: ${r.is_nullable})`);
      });
    }
    
    // Se media_cache existe, verificar estrutura
    if (tablesResult.rows.some(r => r.table_name === 'media_cache')) {
      const structureQuery = `
        SELECT column_name, data_type, is_nullable
        FROM information_schema.columns 
        WHERE table_schema = 'public' 
          AND table_name = 'media_cache'
        ORDER BY ordinal_position
      `;
      
      const structureResult = await pool.query(structureQuery);
      console.log('\n=== ESTRUTURA media_cache ===');
      structureResult.rows.forEach(r => {
        console.log(`- ${r.column_name}: ${r.data_type} (nullable: ${r.is_nullable})`);
      });
      
      // Verificar índices
      const indexQuery = `
        SELECT indexname, indexdef
        FROM pg_indexes
        WHERE tablename = 'media_cache'
        ORDER BY indexname
      `;
      
      const indexResult = await pool.query(indexQuery);
      console.log('\n=== ÍNDICES media_cache ===');
      indexResult.rows.forEach(r => {
        console.log(`- ${r.indexname}`);
      });
    }
    
    console.log('\n✅ Verificação concluída');
    
  } catch (err) {
    console.error('\n❌ ERRO:', err.message);
  } finally {
    await pool.end();
  }
}

checkTables();
