/**
 * Teste de Performance do Sistema de Aquecimento de Mídias
 * 
 * Verifica:
 * - Throughput (mídias/min)
 * - Latência (P50, P95, P99)
 * - Utilização de concorrência
 * - Taxa de sucesso/erro
 */

require('dotenv').config();
const { Pool } = require('pg');

async function testPrewarmPerformance() {
  console.log('\n🚀 TESTE DE PERFORMANCE - PREWARM WORKER\n');
  console.log('━'.repeat(80));
  
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  
  try {
    // 1. Verificar métricas do worker
    console.log('\n📊 Métricas do Worker:\n');
    
    const { getQueueMetrics } = require('../lib/mediaPrewarmWorker');
    const metrics = getQueueMetrics();
    
    console.log(`Queue Size:        ${metrics.queue_size}`);
    console.log(`Processing:        ${metrics.processing_count}`);
    console.log(`Active Workers:    ${metrics.active_workers}`);
    console.log(`Max Concurrency:   ${metrics.max_concurrency}`);
    console.log(`Utilization:       ${metrics.utilization_pct}%`);
    
    // 2. Verificar mídias pendentes
    console.log('\n📦 Mídias Pendentes de Aquecimento:\n');
    
    const warmingQuery = `
      SELECT 
        kind,
        count(*) as count,
        avg(extract(epoch from (now() - created_at))) as avg_age_seconds
      FROM media_cache
      WHERE status = 'warming'
      GROUP BY kind
      ORDER BY kind
    `;
    
    const warmingResult = await pool.query(warmingQuery);
    
    if (warmingResult.rows.length === 0) {
      console.log('✅ Nenhuma mídia pendente');
    } else {
      console.table(warmingResult.rows.map(row => ({
        Tipo: row.kind,
        Quantidade: row.count,
        'Idade Média (s)': Math.round(row.avg_age_seconds)
      })));
    }
    
    // 3. Verificar taxa de sucesso
    console.log('\n✅ Taxa de Sucesso:\n');
    
    const statsQuery = `
      SELECT 
        status,
        kind,
        count(*) as count
      FROM media_cache
      GROUP BY status, kind
      ORDER BY status, kind
    `;
    
    const statsResult = await pool.query(statsQuery);
    
    if (statsResult.rows.length > 0) {
      console.table(statsResult.rows.map(row => ({
        Status: row.status,
        Tipo: row.kind,
        Quantidade: row.count
      })));
      
      const totalReady = statsResult.rows
        .filter(r => r.status === 'ready')
        .reduce((sum, r) => sum + parseInt(r.count), 0);
      
      const totalWarming = statsResult.rows
        .filter(r => r.status === 'warming')
        .reduce((sum, r) => sum + parseInt(r.count), 0);
      
      const totalError = statsResult.rows
        .filter(r => r.status === 'error')
        .reduce((sum, r) => sum + parseInt(r.count), 0);
      
      const total = totalReady + totalWarming + totalError;
      
      if (total > 0) {
        const successRate = (totalReady / total) * 100;
        const errorRate = (totalError / total) * 100;
        
        console.log(`\n📈 Taxa de Sucesso: ${successRate.toFixed(1)}%`);
        console.log(`❌ Taxa de Erro: ${errorRate.toFixed(1)}%`);
        console.log(`⏳ Pendente: ${totalWarming}`);
      }
    } else {
      console.log('⚠️  Nenhuma mídia no cache ainda');
    }
    
    // 4. Verificar latências (últimas 100 mídias aquecidas)
    console.log('\n⏱️  Latências de Aquecimento (últimas 100):\n');
    
    const latencyQuery = `
      SELECT 
        kind,
        extract(epoch from (warmup_at - created_at)) as latency_seconds
      FROM media_cache
      WHERE warmup_at IS NOT NULL
      ORDER BY warmup_at DESC
      LIMIT 100
    `;
    
    const latencyResult = await pool.query(latencyQuery);
    
    if (latencyResult.rows.length > 0) {
      const latencies = latencyResult.rows.map(r => parseFloat(r.latency_seconds));
      latencies.sort((a, b) => a - b);
      
      const p50 = latencies[Math.floor(latencies.length * 0.5)] || 0;
      const p95 = latencies[Math.floor(latencies.length * 0.95)] || 0;
      const p99 = latencies[Math.floor(latencies.length * 0.99)] || 0;
      const avg = latencies.reduce((sum, l) => sum + l, 0) / latencies.length;
      
      console.log(`P50:   ${p50.toFixed(2)}s`);
      console.log(`P95:   ${p95.toFixed(2)}s`);
      console.log(`P99:   ${p99.toFixed(2)}s`);
      console.log(`Média: ${avg.toFixed(2)}s`);
      
      // Comparar com meta
      const metaP95 = 0.8; // 800ms = 0.8s
      if (p95 <= metaP95) {
        console.log(`\n✅ P95 abaixo da meta! (${(p95).toFixed(2)}s <= ${metaP95}s)`);
      } else {
        console.log(`\n⚠️  P95 acima da meta (${(p95).toFixed(2)}s > ${metaP95}s)`);
      }
    } else {
      console.log('⚠️  Nenhuma mídia aquecida ainda');
    }
    
    // 5. Throughput (últimos 10 minutos)
    console.log('\n🚀 Throughput (últimos 10 minutos):\n');
    
    const throughputQuery = `
      SELECT 
        count(*) as total,
        count(*) / 10.0 as per_minute
      FROM media_cache
      WHERE warmup_at IS NOT NULL
        AND warmup_at > now() - interval '10 minutes'
    `;
    
    const throughputResult = await pool.query(throughputQuery);
    
    if (throughputResult.rows[0].total > 0) {
      const perMinute = throughputResult.rows[0].per_minute;
      console.log(`Mídias aquecidas: ${throughputResult.rows[0].total}`);
      console.log(`Throughput: ${perMinute.toFixed(1)} mídias/min`);
      
      // Comparar com meta
      const metaThroughput = 150; // 150 mídias/min (5x paralelismo)
      if (perMinute >= metaThroughput) {
        console.log(`\n✅ Throughput acima da meta! (${perMinute.toFixed(1)} >= ${metaThroughput} mídias/min)`);
      } else {
        console.log(`\n⚠️  Throughput abaixo da meta (${perMinute.toFixed(1)} < ${metaThroughput} mídias/min)`);
      }
    } else {
      console.log('⚠️  Nenhuma mídia aquecida nos últimos 10 minutos');
    }
    
    console.log('\n' + '━'.repeat(80));
    console.log('✅ Teste concluído!\n');
    
  } catch (err) {
    console.error('\n❌ Erro:', err.message);
    console.error(err.stack);
  } finally {
    await pool.end();
  }
}

// Executar teste
if (require.main === module) {
  testPrewarmPerformance().catch(console.error);
}

module.exports = { testPrewarmPerformance };

