/**
 * Script para configurar warmup_chat_id
 * 
 * ANTES DE EXECUTAR:
 * 1. Crie um canal PRIVADO no Telegram (ex: "Bot Media Warmup")
 * 2. Adicione o bot como ADMINISTRADOR do canal
 * 3. Envie uma mensagem /start no canal
 * 4. Acesse: https://api.telegram.org/bot{TOKEN}/getUpdates
 *    (substitua {TOKEN} pelo token do bot)
 * 5. Procure por "chat":{"id":-1001234567890
 * 6. Copie o chat_id (número negativo grande)
 * 
 * Uso: node scripts/setup-warmup-chat.js <bot_slug> <chat_id>
 * Exemplo: node scripts/setup-warmup-chat.js vipshadriee_bot -1001234567890
 */

require('dotenv').config();

async function setupWarmupChat(botSlug, warmupChatId) {
  const ADMIN_TOKEN = process.env.ADMIN_API_TOKEN;
  const API_BASE = process.env.API_BASE_URL || 'http://localhost:3000';
  
  console.log('\n🔧 Configurando warmup_chat_id...\n');
  console.log(`Bot: ${botSlug}`);
  console.log(`Chat ID: ${warmupChatId}\n`);
  
  try {
    const url = `${API_BASE}/api/admin/bots/${botSlug}/warmup-chat`;
    
    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${ADMIN_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        warmup_chat_id: warmupChatId
      })
    });
    
    const data = await response.json();
    
    if (response.ok && data.ok) {
      console.log('✅ SUCESSO! Warmup chat configurado:\n');
      console.log(`   Bot: ${data.slug}`);
      console.log(`   Chat ID: ${data.warmup_chat_id}\n`);
      
      console.log('🎉 Sistema de mídia pronto para uso!');
      console.log('\n📸 Próximo passo: Testar upload de mídia');
      console.log('   node scripts/test-media-upload.js', botSlug, './sua-imagem.jpg\n');
      
    } else {
      console.error('❌ ERRO:', data.error || data.message);
      
      if (data.error === 'BOT_NOT_FOUND') {
        console.log('\n💡 Bot não encontrado. Bots disponíveis:');
        console.log('   • vipshadriee_bot');
      }
      
      process.exit(1);
    }
    
  } catch (err) {
    console.error('❌ ERRO na requisição:', err.message);
    process.exit(1);
  }
}

// Main
const args = process.argv.slice(2);

if (args.length < 2) {
  console.log('\n❌ Argumentos insuficientes\n');
  console.log('Uso: node scripts/setup-warmup-chat.js <bot_slug> <chat_id>');
  console.log('Exemplo: node scripts/setup-warmup-chat.js vipshadriee_bot -1001234567890\n');
  console.log('📋 COMO OBTER O CHAT_ID:\n');
  console.log('1. Crie um canal PRIVADO no Telegram');
  console.log('2. Adicione o bot como ADMINISTRADOR');
  console.log('3. No Telegram Desktop:');
  console.log('   - Abra o canal');
  console.log('   - Clique com botão direito na foto do canal');
  console.log('   - Copiar link do canal');
  console.log('   - Se o link for: https://t.me/c/1234567890/1');
  console.log('   - O chat_id é: -1001234567890 (adicione -100 no início)\n');
  console.log('4. OU envie uma mensagem no canal e acesse:');
  console.log('   https://api.telegram.org/bot{SEU_TOKEN}/getUpdates');
  console.log('   (Remova o webhook antes se necessário)\n');
  process.exit(1);
}

const [botSlug, warmupChatId] = args;

// Validar formato do chat_id
if (!warmupChatId.startsWith('-100')) {
  console.warn('\n⚠️  AVISO: Chat ID normalmente começa com -100');
  console.warn('   Exemplo: -1001234567890');
  console.warn('   Você forneceu:', warmupChatId);
  console.warn('\n   Continuando mesmo assim...\n');
}

setupWarmupChat(botSlug, warmupChatId);
