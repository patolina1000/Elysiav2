require('dotenv').config();

/**
 * Script de teste para endpoints de token
 * Testa: PUT /api/admin/bots/:slug/token e GET /api/admin/bots/:slug/token/status
 */

const BASE_URL = process.env.APP_BASE_URL || 'http://localhost:3000';
const ADMIN_TOKEN = process.env.ADMIN_API_TOKEN;

// Token de teste do BotFather (substitua por um token real para testar validação)
const TEST_BOT_TOKEN = '123456789:ABCdefGHIjklMNOpqrsTUVwxyz-1234567890';
const TEST_SLUG = 'test-bot';

async function testEndpoints() {
  console.log('\n=== TESTE DE ENDPOINTS DE TOKEN ===\n');
  
  if (!ADMIN_TOKEN) {
    console.error('❌ ADMIN_API_TOKEN não configurado no .env');
    process.exit(1);
  }
  
  const headers = {
    'Authorization': `Bearer ${ADMIN_TOKEN}`,
    'Content-Type': 'application/json'
  };
  
  // Teste 1: Criar um bot de teste
  console.log('1️⃣  Criando bot de teste...');
  try {
    const createResponse = await fetch(`${BASE_URL}/api/admin/bots`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        name: 'Bot de Teste Token',
        slug: TEST_SLUG,
        provider: 'manual',
        use_album: false
      })
    });
    
    const createData = await createResponse.json();
    
    if (createResponse.status === 409) {
      console.log('   ℹ️  Bot já existe (ok para teste)');
    } else if (createResponse.ok) {
      console.log('   ✅ Bot criado:', createData.slug);
    } else {
      console.log('   ⚠️  Erro ao criar bot:', createData);
    }
  } catch (err) {
    console.error('   ❌ Erro:', err.message);
  }
  
  // Teste 2: Salvar token válido
  console.log('\n2️⃣  Salvando token para o bot...');
  try {
    const saveResponse = await fetch(`${BASE_URL}/api/admin/bots/${TEST_SLUG}/token`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ token: TEST_BOT_TOKEN })
    });
    
    const saveData = await saveResponse.json();
    
    if (saveResponse.ok && saveData.ok) {
      console.log('   ✅ Token salvo com sucesso!');
      console.log('   📊 Resposta:', JSON.stringify(saveData, null, 2));
    } else {
      console.log('   ❌ Erro ao salvar token:', saveData);
    }
  } catch (err) {
    console.error('   ❌ Erro:', err.message);
  }
  
  // Teste 3: Obter detalhes do bot (verificar has_token e token_updated_at)
  console.log('\n3️⃣  Obtendo detalhes do bot...');
  try {
    const detailResponse = await fetch(`${BASE_URL}/api/admin/bots/${TEST_SLUG}`, {
      method: 'GET',
      headers
    });
    
    const detailData = await detailResponse.json();
    
    if (detailResponse.ok) {
      console.log('   ✅ Detalhes obtidos:');
      console.log('   📊 has_token:', detailData.has_token);
      console.log('   📊 token_updated_at:', detailData.token_updated_at);
      console.log('   📊 token_masked:', detailData.token_masked);
    } else {
      console.log('   ❌ Erro ao obter detalhes:', detailData);
    }
  } catch (err) {
    console.error('   ❌ Erro:', err.message);
  }
  
  // Teste 4: Validar token salvo (vai falhar se token for inválido, mas endpoint deve funcionar)
  console.log('\n4️⃣  Validando token salvo via Telegram API...');
  try {
    const statusResponse = await fetch(`${BASE_URL}/api/admin/bots/${TEST_SLUG}/token/status`, {
      method: 'GET',
      headers
    });
    
    const statusData = await statusResponse.json();
    
    if (statusResponse.ok) {
      if (statusData.ok) {
        console.log('   ✅ Token válido!');
        console.log('   📊 Bot ID:', statusData.bot_id);
        console.log('   📊 Username:', statusData.username);
        console.log('   📊 Can join groups:', statusData.can_join_groups);
      } else {
        console.log('   ⚠️  Token inválido (esperado para token de teste):');
        console.log('   📊 Erro:', statusData.error);
      }
    } else {
      console.log('   ❌ Erro ao validar:', statusData);
    }
  } catch (err) {
    console.error('   ❌ Erro:', err.message);
  }
  
  // Teste 5: Tentar salvar token vazio (deve falhar)
  console.log('\n5️⃣  Testando validação: token vazio...');
  try {
    const emptyResponse = await fetch(`${BASE_URL}/api/admin/bots/${TEST_SLUG}/token`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ token: '' })
    });
    
    const emptyData = await emptyResponse.json();
    
    if (!emptyResponse.ok && emptyData.error === 'MISSING_TOKEN') {
      console.log('   ✅ Validação funcionou: token vazio rejeitado');
    } else {
      console.log('   ❌ Validação falhou: token vazio deveria ser rejeitado');
    }
  } catch (err) {
    console.error('   ❌ Erro:', err.message);
  }
  
  // Teste 6: Tentar salvar token para bot inexistente
  console.log('\n6️⃣  Testando validação: bot inexistente...');
  try {
    const notFoundResponse = await fetch(`${BASE_URL}/api/admin/bots/bot-inexistente-xyz/token`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ token: TEST_BOT_TOKEN })
    });
    
    const notFoundData = await notFoundResponse.json();
    
    if (notFoundResponse.status === 404 && notFoundData.error === 'BOT_NOT_FOUND') {
      console.log('   ✅ Validação funcionou: bot inexistente rejeitado');
    } else {
      console.log('   ❌ Validação falhou: deveria retornar 404');
    }
  } catch (err) {
    console.error('   ❌ Erro:', err.message);
  }
  
  console.log('\n=== TESTES CONCLUÍDOS ===\n');
  console.log('💡 Próximos passos:');
  console.log('   1. Acesse http://localhost:3000/admin');
  console.log('   2. Navegue até o bot "test-bot"');
  console.log('   3. Verifique se o status do token está correto');
  console.log('   4. Teste os botões Salvar e Validar na UI');
  console.log('   5. Use um token real do BotFather para testar validação completa\n');
}

testEndpoints().catch(err => {
  console.error('Erro fatal:', err);
  process.exit(1);
});
