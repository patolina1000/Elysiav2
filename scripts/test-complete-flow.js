/**
 * Script de teste completo do fluxo de mídia
 * 
 * Testa:
 * 1. Configuração do warmup_chat_id
 * 2. Upload de mídia de teste
 * 3. Verificação do status
 * 4. Listagem de mídias
 * 
 * Uso: node scripts/test-complete-flow.js <bot_slug> <warmup_chat_id>
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const ADMIN_TOKEN = process.env.ADMIN_API_TOKEN;
const API_BASE = 'http://localhost:3000';

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function testCompleteFlow(botSlug, warmupChatId) {
  console.log('\n🚀 TESTE COMPLETO DO SISTEMA DE MÍDIA\n');
  console.log('━'.repeat(60));
  
  try {
    // 1. Verificar se servidor está rodando
    console.log('\n1️⃣  Verificando servidor...');
    try {
      const healthResponse = await fetch(`${API_BASE}/healthz`);
      if (healthResponse.ok) {
        console.log('   ✅ Servidor online');
      } else {
        throw new Error('Servidor não respondeu');
      }
    } catch (err) {
      console.log('   ❌ Servidor offline');
      console.log('\n   💡 Execute: npm start\n');
      process.exit(1);
    }
    
    // 2. Configurar warmup_chat_id
    console.log('\n2️⃣  Configurando warmup_chat_id...');
    const warmupUrl = `${API_BASE}/api/admin/bots/${botSlug}/warmup-chat`;
    
    const warmupResponse = await fetch(warmupUrl, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${ADMIN_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ warmup_chat_id: warmupChatId })
    });
    
    const warmupData = await warmupResponse.json();
    
    if (warmupResponse.ok && warmupData.ok) {
      console.log('   ✅ Warmup chat configurado:', warmupData.warmup_chat_id);
    } else {
      console.log('   ⚠️  Erro ao configurar:', warmupData.error);
      if (warmupData.error !== 'BOT_NOT_FOUND') {
        console.log('   Continuando mesmo assim...');
      } else {
        process.exit(1);
      }
    }
    
    // 3. Criar imagem de teste
    console.log('\n3️⃣  Criando imagem de teste...');
    
    // Criar um PNG 1x1 vermelho (mínimo possível)
    const pngData = Buffer.from([
      0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
      0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
      0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // Width=1, Height=1
      0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, // 8bit RGB
      0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41, // IDAT chunk
      0x54, 0x08, 0x99, 0x63, 0xF8, 0xCF, 0xC0, 0x00, // Red pixel
      0x00, 0x03, 0x01, 0x01, 0x00, 0x18, 0xDD, 0x8D,
      0xB4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, // IEND chunk
      0x44, 0xAE, 0x42, 0x60, 0x82
    ]);
    
    const testImagePath = path.join(__dirname, '..', 'test-photo.png');
    fs.writeFileSync(testImagePath, pngData);
    console.log('   ✅ Imagem criada:', testImagePath);
    console.log('   📏 Tamanho:', pngData.length, 'bytes');
    
    // 4. Upload da mídia
    console.log('\n4️⃣  Fazendo upload da mídia...');
    
    const base64Image = pngData.toString('base64');
    
    const uploadUrl = `${API_BASE}/api/admin/bots/${botSlug}/media`;
    const uploadResponse = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ADMIN_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        kind: 'photo',
        data_base64: base64Image,
        mime: 'image/png',
        ext: 'png',
        width: 1,
        height: 1
      })
    });
    
    const uploadData = await uploadResponse.json();
    
    if (uploadResponse.ok && uploadData.ok) {
      console.log('   ✅ Upload realizado com sucesso!');
      console.log('   📦 Media ID:', uploadData.media_id);
      console.log('   🔑 SHA256:', uploadData.sha256.slice(0, 16) + '...');
      console.log('   💾 R2 Key:', uploadData.r2_key);
      console.log('   📊 Tamanho:', uploadData.bytes, 'bytes');
      console.log('   🔥 Status:', uploadData.warming ? 'Aquecendo...' : 'Pronto');
      
      const mediaId = uploadData.media_id;
      
      // 5. Aguardar aquecimento
      console.log('\n5️⃣  Aguardando aquecimento...');
      console.log('   ⏳ Esperando 8 segundos...');
      
      for (let i = 1; i <= 8; i++) {
        process.stdout.write(`\r   ⏱️  ${i}/8 segundos...`);
        await sleep(1000);
      }
      console.log('\r   ✅ Tempo decorrido: 8 segundos     \n');
      
      // 6. Verificar status
      console.log('6️⃣  Verificando status da mídia...');
      
      const statusUrl = `${API_BASE}/api/admin/media/${mediaId}`;
      const statusResponse = await fetch(statusUrl, {
        headers: {
          'Authorization': `Bearer ${ADMIN_TOKEN}`
        }
      });
      
      const statusData = await statusResponse.json();
      
      if (statusResponse.ok && statusData.ok) {
        const media = statusData.media;
        const cache = media.cache;
        
        console.log('   📋 Status da mídia:');
        console.log('      ID:', media.id);
        console.log('      Bot:', media.bot_slug);
        console.log('      Tipo:', media.kind);
        console.log('      R2 Key:', media.r2_key);
        console.log('      Cache Status:', cache.status);
        
        if (cache.status === 'ready') {
          console.log('      ✅ File ID:', cache.file_id?.slice(0, 30) + '...');
          console.log('      ✅ Aquecido em:', cache.warmup_at);
          console.log('\n   🎉 SUCESSO! Mídia pronta para uso!');
        } else if (cache.status === 'warming') {
          console.log('      ⏳ Ainda aquecendo...');
          console.log('\n   💡 Aguarde mais alguns segundos e verifique novamente:');
          console.log(`      curl ${statusUrl} -H "Authorization: Bearer ${ADMIN_TOKEN}"`);
        } else if (cache.status === 'error') {
          console.log('      ❌ Erro:', cache.last_error);
          console.log('\n   💡 Possíveis causas:');
          console.log('      • Warmup chat_id não configurado');
          console.log('      • Bot não é admin do canal');
          console.log('      • Canal não existe');
        }
      }
      
      // 7. Listar todas as mídias
      console.log('\n7️⃣  Listando todas as mídias do bot...');
      
      const listUrl = `${API_BASE}/api/admin/bots/${botSlug}/media?limit=10`;
      const listResponse = await fetch(listUrl, {
        headers: {
          'Authorization': `Bearer ${ADMIN_TOKEN}`
        }
      });
      
      const listData = await listResponse.json();
      
      if (listResponse.ok && listData.ok) {
        console.log(`   📚 Total de mídias: ${listData.count}`);
        
        listData.media.forEach((m, i) => {
          console.log(`\n   ${i + 1}. ${m.kind.toUpperCase()}`);
          console.log(`      ID: ${m.id}`);
          console.log(`      SHA256: ${m.sha256.slice(0, 16)}...`);
          console.log(`      Tamanho: ${m.bytes} bytes`);
          console.log(`      Status: ${m.cache.status}`);
        });
      }
      
      // 8. Métricas da fila
      console.log('\n8️⃣  Verificando métricas da fila...');
      
      const metricsUrl = `${API_BASE}/api/admin/media/queue/metrics`;
      const metricsResponse = await fetch(metricsUrl, {
        headers: {
          'Authorization': `Bearer ${ADMIN_TOKEN}`
        }
      });
      
      const metricsData = await metricsResponse.json();
      
      if (metricsResponse.ok && metricsData.ok) {
        console.log('   📊 Fila de aquecimento:');
        console.log('      Tamanho atual:', metricsData.queue_size);
        console.log('      Em processamento:', metricsData.processing_count);
        console.log('      Máximo:', metricsData.max_queue_size);
      }
      
    } else {
      console.log('   ❌ Erro no upload:', uploadData.error || uploadData.message);
      
      if (uploadData.error === 'R2_NOT_CONFIGURED') {
        console.log('\n   💡 Configure as credenciais R2 no .env:');
        console.log('      R2_ACCOUNT_ID=...');
        console.log('      R2_ACCESS_KEY_ID=...');
        console.log('      R2_SECRET_ACCESS_KEY=...');
      }
      
      process.exit(1);
    }
    
    // Resumo final
    console.log('\n' + '━'.repeat(60));
    console.log('✅ TESTE COMPLETO CONCLUÍDO COM SUCESSO!\n');
    console.log('📋 Próximos passos:');
    console.log('   • Use mídias reais com: node scripts/test-media-upload.js');
    console.log('   • Integre com bot_messages');
    console.log('   • Teste envios em produção\n');
    
  } catch (err) {
    console.error('\n❌ ERRO FATAL:', err.message);
    console.error('Stack:', err.stack);
    process.exit(1);
  }
}

// Main
const args = process.argv.slice(2);

if (args.length < 2) {
  console.log('\nUso: node scripts/test-complete-flow.js <bot_slug> <warmup_chat_id>');
  console.log('Exemplo: node scripts/test-complete-flow.js vipshadriee_bot -1001234567890\n');
  process.exit(1);
}

const [botSlug, warmupChatId] = args;

testCompleteFlow(botSlug, warmupChatId);
