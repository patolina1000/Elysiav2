/**
 * Verifica estrutura da tabela bot_messages
 */

require('dotenv').config();
const { Pool } = require('pg');

async function checkStructure() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  
  try {
    console.log('\n=== ESTRUTURA DE bot_messages ===\n');
    
    // Verificar se tabela existe
    const tableCheck = `
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
        AND table_name = 'bot_messages'
    `;
    
    const tableResult = await pool.query(tableCheck);
    
    if (tableResult.rowCount === 0) {
      console.log('❌ Tabela bot_messages NÃO EXISTE');
      console.log('\n💡 A tabela bot_messages ainda não foi criada.');
      console.log('   Isso é normal se você ainda não implementou o sistema de mensagens.');
      return;
    }
    
    console.log('✅ Tabela bot_messages existe\n');
    
    // Listar todas as colunas
    const columnsQuery = `
      SELECT 
        column_name, 
        data_type, 
        is_nullable,
        column_default
      FROM information_schema.columns 
      WHERE table_schema = 'public' 
        AND table_name = 'bot_messages'
      ORDER BY ordinal_position
    `;
    
    const result = await pool.query(columnsQuery);
    
    console.log('Colunas existentes:');
    result.rows.forEach(r => {
      const nullable = r.is_nullable === 'YES' ? 'NULL' : 'NOT NULL';
      const defaultVal = r.column_default ? ` DEFAULT ${r.column_default}` : '';
      console.log(`  • ${r.column_name}: ${r.data_type} (${nullable})${defaultVal}`);
    });
    
    console.log(`\nTotal: ${result.rows.length} colunas`);
    
    // Verificar se já tem colunas de mídia
    const mediaColumns = result.rows.filter(r => 
      r.column_name.startsWith('media_')
    );
    
    if (mediaColumns.length > 0) {
      console.log('\n⚠️  Colunas de mídia já existem:');
      mediaColumns.forEach(c => console.log(`  ✅ ${c.column_name}`));
    } else {
      console.log('\n💡 Colunas de mídia ainda não foram adicionadas');
    }
    
  } catch (err) {
    console.error('\n❌ ERRO:', err.message);
  } finally {
    await pool.end();
  }
}

checkStructure();
