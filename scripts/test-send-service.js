require('dotenv').config();

/**
 * Script de teste para o serviço de envio
 * Testes obrigatórios conforme especificação
 */

const BASE_URL = process.env.APP_BASE_URL || 'http://localhost:3000';
const ADMIN_TOKEN = process.env.ADMIN_API_TOKEN;

// IMPORTANTE: Configure seu chat_id do Telegram aqui
const YOUR_CHAT_ID = process.env.TEST_CHAT_ID || '123456789';

const TEST_BOT_SLUG = 'bot-ui-test';

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function runTests() {
  console.log('\n=== TESTES DO SERVIÇO DE ENVIO ===\n');
  
  if (!ADMIN_TOKEN) {
    console.error('❌ ADMIN_API_TOKEN não configurado no .env');
    process.exit(1);
  }
  
  const headers = {
    'Authorization': `Bearer ${ADMIN_TOKEN}`,
    'Content-Type': 'application/json'
  };
  
  // Teste 1: Token ausente
  console.log('1️⃣  Teste: Token ausente (slug sem token)');
  try {
    const response = await fetch(`${BASE_URL}/api/admin/bots/bot-sem-token-xyz/send-test`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        chat_id: YOUR_CHAT_ID,
        text: 'Teste'
      })
    });
    
    const data = await response.json();
    
    if (!data.ok && data.error === 'BOT_TOKEN_NOT_SET') {
      console.log('   ✅ Passou: Erro BOT_TOKEN_NOT_SET retornado corretamente');
    } else {
      console.log('   ❌ Falhou: Esperava BOT_TOKEN_NOT_SET, recebeu:', data);
    }
  } catch (err) {
    console.error('   ❌ Erro:', err.message);
  }
  
  // Teste 2: Envio feliz
  console.log('\n2️⃣  Teste: Envio feliz (token válido + seu chat_id)');
  console.log(`   💡 Usando chat_id: ${YOUR_CHAT_ID}`);
  console.log('   💡 Verifique se a mensagem chegou no Telegram!');
  
  try {
    const startTime = Date.now();
    const response = await fetch(`${BASE_URL}/api/admin/bots/${TEST_BOT_SLUG}/send-test`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        chat_id: YOUR_CHAT_ID,
        text: 'Teste de envio ✅\n\nEste é um teste do serviço de envio.'
      })
    });
    
    const data = await response.json();
    const totalTime = Date.now() - startTime;
    
    if (data.ok) {
      console.log('   ✅ Passou: Mensagem enviada com sucesso!');
      console.log('   📊 message_id:', data.message_id);
      console.log('   📊 lat_ms:', data.lat_ms);
      console.log('   📊 telegram_lat_ms:', data.telegram_lat_ms);
      console.log('   📊 total_time:', totalTime, 'ms');
      console.log('   📊 dedupe_applied:', data.dedupe_applied || false);
      
      if (data.lat_ms <= 800) {
        console.log('   ✅ SLO: Latência dentro do alvo (≤800ms)');
      } else {
        console.log('   ⚠️  SLO: Latência acima do alvo (>800ms)');
      }
    } else {
      console.log('   ❌ Falhou:', data.error);
      console.log('   📊 Detalhes:', data.description);
    }
  } catch (err) {
    console.error('   ❌ Erro:', err.message);
  }
  
  // Teste 3: Deduplicação
  console.log('\n3️⃣  Teste: Deduplicação (repetir mesmo envio em <1min)');
  console.log('   💡 Aguardando 2s antes de reenviar...');
  await sleep(2000);
  
  try {
    const response = await fetch(`${BASE_URL}/api/admin/bots/${TEST_BOT_SLUG}/send-test`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        chat_id: YOUR_CHAT_ID,
        text: 'Teste de envio ✅\n\nEste é um teste do serviço de envio.'
      })
    });
    
    const data = await response.json();
    
    if (data.ok && data.dedupe_applied === true) {
      console.log('   ✅ Passou: Deduplicação aplicada!');
      console.log('   📊 message_id:', data.message_id, '(mesmo da mensagem anterior)');
      console.log('   💡 Confirme no Telegram que NÃO chegou nova mensagem');
    } else if (data.ok && !data.dedupe_applied) {
      console.log('   ⚠️  Atenção: Mensagem enviada novamente (dedupe não aplicado)');
      console.log('   📊 Pode ser que o minuto tenha virado');
    } else {
      console.log('   ❌ Falhou:', data);
    }
  } catch (err) {
    console.error('   ❌ Erro:', err.message);
  }
  
  // Teste 4: Rate limit por bot (70 envios em 60s)
  console.log('\n4️⃣  Teste: Rate limit por bot (70 envios rápidos)');
  console.log('   💡 Este teste pode demorar ~10s...');
  
  let successCount = 0;
  let queuedCount = 0;
  let errorCount = 0;
  
  const promises = [];
  for (let i = 0; i < 70; i++) {
    const promise = fetch(`${BASE_URL}/api/admin/bots/${TEST_BOT_SLUG}/send-test`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        chat_id: YOUR_CHAT_ID,
        text: `Rate test ${i + 1}`
      })
    })
    .then(r => r.json())
    .then(data => {
      if (data.ok) successCount++;
      else if (data.error && data.error.includes('QUEUED')) queuedCount++;
      else errorCount++;
    })
    .catch(() => errorCount++);
    
    promises.push(promise);
    
    // Pequeno delay para não sobrecarregar
    if (i % 10 === 0) await sleep(50);
  }
  
  await Promise.all(promises);
  
  console.log('   📊 Resultados:');
  console.log('   📊 Sucesso:', successCount);
  console.log('   📊 Enfileirados:', queuedCount);
  console.log('   📊 Erros:', errorCount);
  
  if (queuedCount > 0 && errorCount === 0) {
    console.log('   ✅ Passou: Rate limit funcionando (alguns enfileirados, nenhum erro)');
  } else if (errorCount === 0) {
    console.log('   ⚠️  Atenção: Todos passaram (rate limit pode não estar ativo)');
  } else {
    console.log('   ❌ Falhou: Erros encontrados');
  }
  
  // Teste 5: Flood por chat
  console.log('\n5️⃣  Teste: Flood por chat (2 mensagens imediatas)');
  
  try {
    const start1 = Date.now();
    const promise1 = fetch(`${BASE_URL}/api/admin/bots/${TEST_BOT_SLUG}/send-test`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        chat_id: YOUR_CHAT_ID,
        text: 'Flood test 1'
      })
    });
    
    // Enviar segunda imediatamente
    const promise2 = fetch(`${BASE_URL}/api/admin/bots/${TEST_BOT_SLUG}/send-test`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        chat_id: YOUR_CHAT_ID,
        text: 'Flood test 2'
      })
    });
    
    const [resp1, resp2] = await Promise.all([promise1, promise2]);
    const [data1, data2] = await Promise.all([resp1.json(), resp2.json()]);
    
    const time1 = data1.lat_ms || 0;
    const time2 = data2.lat_ms || 0;
    const diff = Math.abs(time2 - time1);
    
    console.log('   📊 Mensagem 1:', data1.ok ? 'OK' : data1.error);
    console.log('   📊 Mensagem 2:', data2.ok ? 'OK' : data2.error);
    console.log('   📊 Diferença de tempo:', diff, 'ms');
    
    if (diff >= 1000 || data2.error?.includes('QUEUED')) {
      console.log('   ✅ Passou: Segunda mensagem esperou ≥1s ou foi enfileirada');
    } else {
      console.log('   ⚠️  Atenção: Ambas enviadas rapidamente (flood control pode não estar ativo)');
    }
  } catch (err) {
    console.error('   ❌ Erro:', err.message);
  }
  
  // Teste 6: Chat ID inválido
  console.log('\n6️⃣  Teste: Chat ID inválido (erro mapeado)');
  
  try {
    const response = await fetch(`${BASE_URL}/api/admin/bots/${TEST_BOT_SLUG}/send-test`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        chat_id: '999999999999999',
        text: 'Teste com chat inválido'
      })
    });
    
    const data = await response.json();
    
    if (!data.ok && data.error && !data.error.includes('stack')) {
      console.log('   ✅ Passou: Erro mapeado corretamente');
      console.log('   📊 Erro:', data.error);
      console.log('   📊 Descrição:', data.description || 'N/A');
      console.log('   💡 Sem stack trace no response (seguro)');
    } else if (data.ok) {
      console.log('   ⚠️  Atenção: Mensagem enviada (chat pode existir)');
    } else {
      console.log('   ❌ Falhou: Stack trace ou erro não mapeado:', data);
    }
  } catch (err) {
    console.error('   ❌ Erro:', err.message);
  }
  
  // Teste 7: Verificar métricas
  console.log('\n7️⃣  Teste: Verificar métricas');
  
  try {
    const response = await fetch(`${BASE_URL}/api/admin/metrics/send`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${ADMIN_TOKEN}` }
    });
    
    const metrics = await response.json();
    
    console.log('   ✅ Métricas obtidas:');
    console.log('   📊 OK:', Object.keys(metrics.ok || {}).length, 'chaves');
    console.log('   📊 ERR:', Object.keys(metrics.err || {}).length, 'chaves');
    console.log('   📊 Latency:', Object.keys(metrics.latency || {}).length, 'chaves');
    
    // Mostrar algumas métricas
    for (const [key, value] of Object.entries(metrics.ok || {})) {
      console.log(`   📊 ${key}: ${value} envios OK`);
    }
    
    for (const [key, stats] of Object.entries(metrics.latency || {})) {
      console.log(`   📊 ${key}: p95=${stats.p95}ms, avg=${Math.round(stats.avg)}ms`);
    }
  } catch (err) {
    console.error('   ❌ Erro:', err.message);
  }
  
  console.log('\n=== TESTES CONCLUÍDOS ===\n');
  console.log('💡 Próximos passos:');
  console.log('   1. Verifique seu Telegram para confirmar recebimento das mensagens');
  console.log('   2. Acesse http://localhost:3000/admin');
  console.log('   3. Navegue até o bot e teste a UI de "Enviar teste"');
  console.log('   4. Configure um token real do BotFather para testes completos');
  console.log('   5. Verifique os logs do servidor para confirmar que tokens não vazam\n');
}

runTests().catch(err => {
  console.error('Erro fatal:', err);
  process.exit(1);
});
