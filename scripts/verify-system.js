/**
 * Script de verificação do sistema
 * Verifica se tudo está pronto para uso
 */

require('dotenv').config();
const { Pool } = require('pg');

async function verifySystem() {
  console.log('\n🔍 VERIFICAÇÃO DO SISTEMA DE MÍDIA\n');
  console.log('━'.repeat(60));
  
  let allOk = true;
  
  // 1. Verificar variáveis de ambiente
  console.log('\n1️⃣  Variáveis de Ambiente:');
  
  const envVars = {
    'DATABASE_URL': process.env.DATABASE_URL,
    'ADMIN_API_TOKEN': process.env.ADMIN_API_TOKEN,
    'ENCRYPTION_KEY': process.env.ENCRYPTION_KEY,
    'R2_ACCOUNT_ID': process.env.R2_ACCOUNT_ID,
    'R2_ACCESS_KEY_ID': process.env.R2_ACCESS_KEY_ID,
    'R2_SECRET_ACCESS_KEY': process.env.R2_SECRET_ACCESS_KEY,
    'R2_BUCKET': process.env.R2_BUCKET
  };
  
  for (const [key, value] of Object.entries(envVars)) {
    if (value) {
      const masked = key.includes('SECRET') || key.includes('TOKEN') || key.includes('KEY')
        ? value.slice(0, 8) + '...' + value.slice(-4)
        : value.length > 30 
        ? value.slice(0, 30) + '...'
        : value;
      console.log(`   ✅ ${key}: ${masked}`);
    } else {
      console.log(`   ❌ ${key}: NÃO CONFIGURADO`);
      allOk = false;
    }
  }
  
  // 2. Verificar conexão com banco
  console.log('\n2️⃣  Banco de Dados:');
  
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  
  try {
    await pool.query('SELECT 1');
    console.log('   ✅ Conectado ao PostgreSQL');
  } catch (err) {
    console.log('   ❌ Erro ao conectar:', err.message);
    allOk = false;
  }
  
  // 3. Verificar tabelas
  console.log('\n3️⃣  Tabelas:');
  
  try {
    const tablesQuery = `
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
        AND table_name IN ('media_store', 'media_cache', 'bots')
      ORDER BY table_name
    `;
    
    const result = await pool.query(tablesQuery);
    const tables = result.rows.map(r => r.table_name);
    
    ['media_store', 'media_cache', 'bots'].forEach(table => {
      if (tables.includes(table)) {
        console.log(`   ✅ ${table}`);
      } else {
        console.log(`   ❌ ${table} não encontrada`);
        allOk = false;
      }
    });
  } catch (err) {
    console.log('   ❌ Erro ao verificar tabelas:', err.message);
    allOk = false;
  }
  
  // 4. Verificar coluna warmup_chat_id
  console.log('\n4️⃣  Coluna warmup_chat_id:');
  
  try {
    const columnQuery = `
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_schema = 'public' 
        AND table_name = 'bots' 
        AND column_name = 'warmup_chat_id'
    `;
    
    const result = await pool.query(columnQuery);
    
    if (result.rowCount > 0) {
      console.log('   ✅ Coluna existe na tabela bots');
    } else {
      console.log('   ❌ Coluna NÃO existe');
      allOk = false;
    }
  } catch (err) {
    console.log('   ❌ Erro ao verificar coluna:', err.message);
    allOk = false;
  }
  
  // 5. Verificar índices
  console.log('\n5️⃣  Índices de media_cache:');
  
  try {
    const indexQuery = `
      SELECT indexname 
      FROM pg_indexes 
      WHERE tablename = 'media_cache'
      ORDER BY indexname
    `;
    
    const result = await pool.query(indexQuery);
    
    const expectedIndexes = [
      'ix_media_cache_bot_slug',
      'ix_media_cache_status',
      'ux_media_cache_key'
    ];
    
    const foundIndexes = result.rows.map(r => r.indexname);
    
    expectedIndexes.forEach(idx => {
      if (foundIndexes.includes(idx)) {
        console.log(`   ✅ ${idx}`);
      } else {
        console.log(`   ⚠️  ${idx} não encontrado`);
      }
    });
  } catch (err) {
    console.log('   ❌ Erro ao verificar índices:', err.message);
  }
  
  // 6. Verificar bot
  console.log('\n6️⃣  Bot Configurado:');
  
  try {
    const botQuery = `
      SELECT slug, 
             (token_encrypted IS NOT NULL) as has_token,
             warmup_chat_id
      FROM bots 
      WHERE deleted_at IS NULL
      LIMIT 1
    `;
    
    const result = await pool.query(botQuery);
    
    if (result.rowCount > 0) {
      const bot = result.rows[0];
      console.log(`   ✅ Bot: ${bot.slug}`);
      console.log(`   ${bot.has_token ? '✅' : '❌'} Token configurado`);
      
      if (bot.warmup_chat_id) {
        console.log(`   ✅ Warmup Chat ID: ${bot.warmup_chat_id}`);
      } else {
        console.log(`   ⏳ Warmup Chat ID: NÃO CONFIGURADO`);
        console.log(`      Execute: node scripts/setup-warmup-chat.js ${bot.slug} -1001234567890`);
      }
    } else {
      console.log('   ⚠️  Nenhum bot encontrado');
    }
  } catch (err) {
    console.log('   ❌ Erro ao verificar bot:', err.message);
  }
  
  // 7. Verificar servidor
  console.log('\n7️⃣  Servidor:');
  
  try {
    const response = await fetch('http://localhost:3000/healthz');
    
    if (response.ok) {
      console.log('   ✅ Servidor online (porta 3000)');
    } else {
      console.log('   ❌ Servidor não respondeu corretamente');
      allOk = false;
    }
  } catch (err) {
    console.log('   ❌ Servidor offline');
    console.log('      Execute: npm start');
    allOk = false;
  }
  
  // 8. Verificar API endpoints
  console.log('\n8️⃣  API Endpoints:');
  
  const endpoints = [
    '/api/admin/media/queue/metrics',
    '/healthz',
    '/health'
  ];
  
  for (const endpoint of endpoints) {
    try {
      const url = `http://localhost:3000${endpoint}`;
      const headers = endpoint.includes('/api/admin')
        ? { 'Authorization': `Bearer ${process.env.ADMIN_API_TOKEN}` }
        : {};
      
      const response = await fetch(url, { headers });
      
      if (response.ok) {
        console.log(`   ✅ ${endpoint}`);
      } else {
        console.log(`   ⚠️  ${endpoint} (${response.status})`);
      }
    } catch (err) {
      console.log(`   ❌ ${endpoint} (offline)`);
    }
  }
  
  // Resumo final
  console.log('\n' + '━'.repeat(60));
  
  if (allOk) {
    console.log('✅ SISTEMA 100% OPERACIONAL\n');
    console.log('🚀 Próximos passos:');
    console.log('   1. Configure warmup_chat_id (se ainda não configurou)');
    console.log('   2. Teste upload: node scripts/test-complete-flow.js\n');
  } else {
    console.log('⚠️  SISTEMA PARCIALMENTE OPERACIONAL\n');
    console.log('🔧 Corrija os itens marcados com ❌ acima\n');
  }
  
  await pool.end();
}

verifySystem().catch(err => {
  console.error('\n❌ ERRO FATAL:', err.message);
  process.exit(1);
});
