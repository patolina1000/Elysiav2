require('dotenv').config();
const { Client } = require('pg');

async function run() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  
  await client.connect();
  
  const result = await client.query(`
    SELECT indexname, indexdef 
    FROM pg_indexes 
    WHERE tablename = 'downsells_queue' 
    ORDER BY indexname
  `);
  
  console.log('\n📋 Índices na tabela downsells_queue:\n');
  
  if (result.rows.length === 0) {
    console.log('❌ Nenhum índice encontrado!\n');
  } else {
    result.rows.forEach(row => {
      console.log(`✅ ${row.indexname}`);
      console.log(`   ${row.indexdef}\n`);
    });
  }
  
  await client.end();
}

run().catch(err => {
  console.error('❌ Erro:', err.message);
  process.exit(1);
});
