require('dotenv').config();
const { Client } = require('pg');

async function run() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  
  await client.connect();
  
  console.log('\n🔧 Corrigindo índice ux_downsells_queue_event_id...\n');
  
  try {
    // 1. Dropar índice antigo (com WHERE)
    console.log('1️⃣ Removendo índice antigo...');
    await client.query('DROP INDEX IF EXISTS public.ux_downsells_queue_event_id');
    console.log('   ✅ Índice antigo removido\n');
    
    // 2. Criar novo índice SEM WHERE (para permitir ON CONFLICT)
    console.log('2️⃣ Criando novo índice único...');
    await client.query(`
      CREATE UNIQUE INDEX ux_downsells_queue_event_id 
      ON public.downsells_queue (event_id)
    `);
    console.log('   ✅ Novo índice criado\n');
    
    // 3. Verificar
    const result = await client.query(`
      SELECT indexname, indexdef 
      FROM pg_indexes 
      WHERE tablename = 'downsells_queue' AND indexname = 'ux_downsells_queue_event_id'
    `);
    
    if (result.rows.length > 0) {
      console.log('3️⃣ Verificação:');
      console.log('   ✅', result.rows[0].indexdef);
      console.log('');
      console.log('✅ Correção aplicada com sucesso!');
      console.log('   Agora os downsells poderão ser agendados.');
    } else {
      console.error('❌ Índice não foi criado!');
    }
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
