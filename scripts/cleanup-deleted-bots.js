/**
 * Script para limpar PERMANENTEMENTE todos os bots que foram soft deleted
 * Remove TODOS os dados relacionados de forma irreversível
 */

require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL?.includes('localhost') ? false : { rejectUnauthorized: false }
});

async function cleanupDeletedBots() {
  console.log('[CLEANUP][START] Buscando bots soft deleted...\n');
  
  try {
    // 1. Buscar todos os bots com deleted_at preenchido
    const botsResult = await pool.query(`
      SELECT id, slug, name, deleted_at 
      FROM public.bots 
      WHERE deleted_at IS NOT NULL
      ORDER BY deleted_at DESC
    `);
    
    if (botsResult.rowCount === 0) {
      console.log('✅ Nenhum bot soft deleted encontrado. Banco está limpo!\n');
      return;
    }
    
    console.log(`🗑️  Encontrados ${botsResult.rowCount} bot(s) soft deleted:\n`);
    botsResult.rows.forEach((bot, i) => {
      console.log(`   ${i + 1}. ${bot.name || '(sem nome)'} (${bot.slug}) - Deletado em: ${bot.deleted_at}`);
    });
    
    console.log('\n⚠️  ATENÇÃO: Todos esses bots e seus dados serão PERMANENTEMENTE excluídos!');
    console.log('⚠️  Esta ação é IRREVERSÍVEL!\n');
    
    // Aguardar 3 segundos para o usuário ler
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    console.log('🔥 Iniciando exclusão permanente em 2 segundos...\n');
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    let totalDeleted = 0;
    const allStats = {};
    
    // 2. Para cada bot, fazer hard delete completo
    for (const bot of botsResult.rows) {
      console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
      console.log(`🗑️  Deletando bot: ${bot.name || '(sem nome)'} (${bot.slug})`);
      console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`);
      
      const stats = {};
      
      try {
        // Deletar shots_queue
        const shotsQueue = await pool.query('DELETE FROM public.shots_queue WHERE slug = $1', [bot.slug]);
        stats.shots_queue = shotsQueue.rowCount;
        console.log(`   ✓ shots_queue: ${shotsQueue.rowCount} registros`);
        
        // Deletar shots
        const shots = await pool.query('DELETE FROM public.shots WHERE slug = $1', [bot.slug]);
        stats.shots = shots.rowCount;
        console.log(`   ✓ shots: ${shots.rowCount} registros`);
        
        // Deletar downsells_queue
        const downsellsQueue = await pool.query('DELETE FROM public.downsells_queue WHERE slug = $1', [bot.slug]);
        stats.downsells_queue = downsellsQueue.rowCount;
        console.log(`   ✓ downsells_queue: ${downsellsQueue.rowCount} registros`);
        
        // Deletar bot_downsells
        const downsells = await pool.query('DELETE FROM public.bot_downsells WHERE slug = $1', [bot.slug]);
        stats.bot_downsells = downsells.rowCount;
        console.log(`   ✓ bot_downsells: ${downsells.rowCount} registros`);
        
        // Deletar bot_messages
        const messages = await pool.query('DELETE FROM public.bot_messages WHERE slug = $1', [bot.slug]);
        stats.bot_messages = messages.rowCount;
        console.log(`   ✓ bot_messages: ${messages.rowCount} registros`);
        
        // Deletar gateway_events
        const gateway = await pool.query('DELETE FROM public.gateway_events WHERE slug = $1', [bot.slug]);
        stats.gateway_events = gateway.rowCount;
        console.log(`   ✓ gateway_events: ${gateway.rowCount} registros`);
        
        // Deletar funnel_events (com fallback)
        try {
          const funnel = await pool.query('DELETE FROM public.funnel_events WHERE bot_slug = $1', [bot.slug]);
          stats.funnel_events = funnel.rowCount;
          console.log(`   ✓ funnel_events: ${funnel.rowCount} registros`);
        } catch (err) {
          stats.funnel_events = 0;
          console.log(`   ⚠ funnel_events: tabela não existe ou erro (${err.message})`);
        }
        
        // Deletar payments (com fallback)
        try {
          const payments = await pool.query('DELETE FROM public.payments WHERE bot_slug = $1 OR bot_id = $2', [bot.slug, bot.id]);
          stats.payments = payments.rowCount;
          console.log(`   ✓ payments: ${payments.rowCount} registros`);
        } catch (err) {
          stats.payments = 0;
          console.log(`   ⚠ payments: tabela não existe ou erro (${err.message})`);
        }
        
        // Deletar o próprio bot
        const botDelete = await pool.query('DELETE FROM public.bots WHERE slug = $1', [bot.slug]);
        stats.bot = botDelete.rowCount;
        console.log(`   ✓ bots: ${botDelete.rowCount} registro\n`);
        
        // Calcular total
        const totalRecords = Object.values(stats).reduce((sum, count) => sum + count, 0);
        console.log(`   📊 Total: ${totalRecords} registros deletados`);
        
        // Acumular estatísticas gerais
        Object.keys(stats).forEach(key => {
          allStats[key] = (allStats[key] || 0) + stats[key];
        });
        
        totalDeleted++;
        
      } catch (err) {
        console.error(`\n   ❌ ERRO ao deletar bot ${bot.slug}:`, err.message);
        console.error(`   Stack: ${err.stack}\n`);
      }
    }
    
    // Resumo final
    console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('📊 RESUMO FINAL');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
    console.log(`✅ Bots deletados: ${totalDeleted} / ${botsResult.rowCount}`);
    console.log('\n📋 Registros deletados por tabela:');
    Object.entries(allStats).forEach(([table, count]) => {
      console.log(`   ${table}: ${count}`);
    });
    
    const grandTotal = Object.values(allStats).reduce((sum, count) => sum + count, 0);
    console.log(`\n🔥 TOTAL GERAL: ${grandTotal} registros permanentemente excluídos\n`);
    
  } catch (err) {
    console.error('\n❌ ERRO FATAL:', err);
    throw err;
  } finally {
    await pool.end();
    console.log('✓ Conexão com banco encerrada\n');
  }
}

// Executar
cleanupDeletedBots()
  .then(() => {
    console.log('✅ Cleanup concluído com sucesso!\n');
    process.exit(0);
  })
  .catch((err) => {
    console.error('❌ Cleanup falhou:', err);
    process.exit(1);
  });
