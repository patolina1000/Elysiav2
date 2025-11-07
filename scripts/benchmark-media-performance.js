/**
 * Benchmark de Performance do Sistema de Mídia
 * 
 * Testa:
 * - Latência de cache lookup
 * - Latência de envio com cache hit
 * - Latência de envio com cache miss
 * - Taxa de cache hit
 * - Throughput de uploads
 * 
 * Uso: node scripts/benchmark-media-performance.js <bot_slug> <warmup_chat_id>
 */

require('dotenv').config();
const { Pool } = require('pg');
const { saveMedia, getCachedFileId } = require('../lib/mediaService');
const { sendMediaMessage } = require('../lib/sendService');

const ADMIN_TOKEN = process.env.ADMIN_API_TOKEN;
const API_BASE = 'http://localhost:3000';

// Criar imagem de teste mínima (PNG 1x1)
function createTestImage() {
  return Buffer.from([
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
    0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
    0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41,
    0x54, 0x08, 0x99, 0x63, 0xF8, 0xCF, 0xC0, 0x00,
    0x00, 0x03, 0x01, 0x01, 0x00, 0x18, 0xDD, 0x8D,
    0xB4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E,
    0x44, 0xAE, 0x42, 0x60, 0x82
  ]);
}

async function benchmark(botSlug, warmupChatId) {
  console.log('\n🚀 BENCHMARK DE PERFORMANCE - SISTEMA DE MÍDIA\n');
  console.log('='.repeat(70));
  
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  
  const results = {
    cache_lookup: [],
    upload: [],
    send_with_cache: [],
    send_without_cache: []
  };
  
  try {
    // 1. BENCHMARK: Cache Lookup
    console.log('\n📊 Teste 1: Cache Lookup Latency');
    console.log('-'.repeat(70));
    
    const testImage = createTestImage();
    const uploadResult = await saveMedia(pool, testImage, botSlug, 'photo', {
      mime: 'image/png',
      ext: 'png'
    });
    
    console.log(`   Upload inicial: ${uploadResult.sha256.slice(0, 16)}...`);
    
    // Aguardar aquecimento
    console.log('   Aguardando aquecimento (10s)...');
    await new Promise(resolve => setTimeout(resolve, 10000));
    
    // Executar 100 lookups
    console.log('   Executando 100 cache lookups...');
    for (let i = 0; i < 100; i++) {
      const start = Date.now();
      await getCachedFileId(pool, botSlug, uploadResult.sha256, 'photo');
      const latency = Date.now() - start;
      results.cache_lookup.push(latency);
      
      if ((i + 1) % 25 === 0) {
        process.stdout.write(`\r   Progresso: ${i + 1}/100`);
      }
    }
    
    console.log('\r   ✅ Completo!                    ');
    
    const cacheLookupStats = calculateStats(results.cache_lookup);
    console.log(`\n   Resultados:`);
    console.log(`   • p50: ${cacheLookupStats.p50}ms`);
    console.log(`   • p95: ${cacheLookupStats.p95}ms`);
    console.log(`   • p99: ${cacheLookupStats.p99}ms`);
    console.log(`   • Média: ${cacheLookupStats.avg}ms`);
    console.log(`   • Min/Max: ${cacheLookupStats.min}ms / ${cacheLookupStats.max}ms`);
    
    // 2. BENCHMARK: Upload Performance
    console.log('\n📊 Teste 2: Upload Performance (10 uploads)');
    console.log('-'.repeat(70));
    
    for (let i = 0; i < 10; i++) {
      const start = Date.now();
      await saveMedia(pool, testImage, botSlug, 'photo', {
        mime: 'image/png',
        ext: 'png'
      });
      const latency = Date.now() - start;
      results.upload.push(latency);
      
      process.stdout.write(`\r   Upload ${i + 1}/10 concluído (${latency}ms)`);
    }
    
    console.log('\n   ✅ Completo!');
    
    const uploadStats = calculateStats(results.upload);
    console.log(`\n   Resultados:`);
    console.log(`   • p50: ${uploadStats.p50}ms`);
    console.log(`   • p95: ${uploadStats.p95}ms`);
    console.log(`   • Média: ${uploadStats.avg}ms`);
    
    // 3. BENCHMARK: Envio com Cache Hit
    console.log('\n📊 Teste 3: Envio com Cache Hit (50 envios)');
    console.log('-'.repeat(70));
    
    // Criar um chat_id de teste
    const testChatId = warmupChatId; // Usar o canal de warmup
    
    console.log(`   Testando envios para: ${testChatId}`);
    console.log('   Aguardando 3s entre requisições...\n');
    
    for (let i = 0; i < 50; i++) {
      const start = Date.now();
      const result = await sendMediaMessage(pool, {
        slug: botSlug,
        chat_id: testChatId,
        media_sha256: uploadResult.sha256,
        media_kind: 'photo',
        media_r2_key: uploadResult.r2_key,
        caption: `Teste ${i + 1}/50`,
        purpose: 'benchmark'
      });
      const latency = Date.now() - start;
      
      if (result.ok && result.cache_hit) {
        results.send_with_cache.push(latency);
        process.stdout.write(`\r   ✅ ${i + 1}/50 (${latency}ms) - Cache HIT`);
      } else {
        process.stdout.write(`\r   ⚠️  ${i + 1}/50 (${latency}ms) - ${result.error || 'Erro'}`);
      }
      
      // Delay entre envios para respeitar rate limits
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
    
    console.log('\n   ✅ Completo!');
    
    if (results.send_with_cache.length > 0) {
      const sendStats = calculateStats(results.send_with_cache);
      console.log(`\n   Resultados:`);
      console.log(`   • p50: ${sendStats.p50}ms`);
      console.log(`   • p95: ${sendStats.p95}ms 🎯 ${sendStats.p95 < 500 ? '✅ META ATINGIDA!' : '❌ ACIMA DA META'}`);
      console.log(`   • p99: ${sendStats.p99}ms`);
      console.log(`   • Média: ${sendStats.avg}ms`);
      console.log(`   • Min/Max: ${sendStats.min}ms / ${sendStats.max}ms`);
      console.log(`   • Taxa de sucesso: ${results.send_with_cache.length}/50 (${(results.send_with_cache.length/50*100).toFixed(1)}%)`);
    } else {
      console.log('\n   ⚠️  Nenhum envio com cache hit bem-sucedido');
    }
    
    // Resumo Final
    console.log('\n' + '='.repeat(70));
    console.log('📊 RESUMO DO BENCHMARK\n');
    
    console.log('1. Cache Lookup:');
    console.log(`   p95: ${cacheLookupStats.p95}ms (meta: <50ms) ${cacheLookupStats.p95 < 50 ? '✅' : '⚠️'}`);
    
    console.log('\n2. Upload R2:');
    console.log(`   p95: ${uploadStats.p95}ms (meta: <2000ms) ${uploadStats.p95 < 2000 ? '✅' : '⚠️'}`);
    
    if (results.send_with_cache.length > 0) {
      const sendStats = calculateStats(results.send_with_cache);
      console.log('\n3. Envio com Cache:');
      console.log(`   p95: ${sendStats.p95}ms (meta: <500ms) ${sendStats.p95 < 500 ? '✅ META ATINGIDA!' : '❌ ACIMA DA META'}`);
      
      // Calcular cache hit rate
      const cacheHitRate = (results.send_with_cache.length / 50 * 100).toFixed(1);
      console.log(`   Cache Hit Rate: ${cacheHitRate}% (meta: >95%) ${cacheHitRate > 95 ? '✅' : '⚠️'}`);
    }
    
    console.log('\n' + '='.repeat(70));
    console.log('✅ Benchmark concluído!\n');
    
  } catch (err) {
    console.error('\n❌ ERRO:', err.message);
    console.error('Stack:', err.stack);
  } finally {
    await pool.end();
  }
}

function calculateStats(values) {
  if (values.length === 0) return { min: 0, max: 0, avg: 0, p50: 0, p95: 0, p99: 0 };
  
  const sorted = [...values].sort((a, b) => a - b);
  const sum = values.reduce((a, b) => a + b, 0);
  
  return {
    min: Math.round(sorted[0]),
    max: Math.round(sorted[sorted.length - 1]),
    avg: Math.round(sum / values.length),
    p50: Math.round(sorted[Math.floor(sorted.length * 0.5)]),
    p95: Math.round(sorted[Math.floor(sorted.length * 0.95)]),
    p99: Math.round(sorted[Math.floor(sorted.length * 0.99)])
  };
}

// Main
const args = process.argv.slice(2);

if (args.length < 2) {
  console.log('\nUso: node scripts/benchmark-media-performance.js <bot_slug> <warmup_chat_id>');
  console.log('Exemplo: node scripts/benchmark-media-performance.js vipshadriee_bot -1001234567890\n');
  console.log('⚠️  ATENÇÃO: Este script faz múltiplos envios para o canal de warmup.');
  console.log('   Certifique-se de que o bot tem permissões adequadas.\n');
  process.exit(1);
}

const [botSlug, warmupChatId] = args;

console.log('\n⚠️  Este benchmark irá:');
console.log('   • Fazer 100 cache lookups');
console.log('   • Fazer 10 uploads');
console.log('   • Enviar 50 mensagens com mídia');
console.log('   • Duração estimada: ~5-10 minutos\n');

console.log('Deseja continuar? Pressione Ctrl+C para cancelar...');
setTimeout(() => {
  benchmark(botSlug, warmupChatId);
}, 3000);
