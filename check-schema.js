require('dotenv').config();
const { Client } = require('pg');

async function run() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  
  await client.connect();
  
  const result = await client.query(`
    SELECT column_name, data_type 
    FROM information_schema.columns 
    WHERE table_name = 'downsells_queue' 
    ORDER BY column_name
  `);
  
  console.log('\n📋 Colunas na tabela downsells_queue:\n');
  result.rows.forEach(row => {
    console.log(`  - ${row.column_name.padEnd(20)} (${row.data_type})`);
  });
  
  await client.end();
}

run().catch(console.error);
