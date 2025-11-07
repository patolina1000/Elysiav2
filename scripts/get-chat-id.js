/**
 * Script para obter chat_id de um canal/grupo
 * 
 * Uso:
 * 1. Envie uma mensagem no canal onde o bot está como admin
 * 2. Execute: node scripts/get-chat-id.js vipshadriee_bot
 */

require('dotenv').config();
const { Pool } = require('pg');
const { getTokenBySlug } = require('../lib/tokenService');

async function getChatId(botSlug) {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  
  try {
    console.log(`\n🔍 Buscando chat_id para: ${botSlug}\n`);
    
    // 1. Obter token do bot
    const token = await getTokenBySlug(pool, botSlug);
    
    if (!token) {
      console.error('❌ Bot não encontrado ou sem token configurado');
      process.exit(1);
    }
    
    console.log('✅ Token do bot encontrado');
    
    // 2. Buscar updates recentes do Telegram
    const url = `https://api.telegram.org/bot${token}/getUpdates?limit=10`;
    
    console.log('📡 Buscando updates do Telegram...\n');
    
    const response = await fetch(url);
    const data = await response.json();
    
    if (!data.ok) {
      console.error('❌ Erro ao buscar updates:', data.description);
      process.exit(1);
    }
    
    if (data.result.length === 0) {
      console.log('⚠️  Nenhum update encontrado.');
      console.log('\n💡 INSTRUÇÕES:');
      console.log('   1. Crie um canal privado no Telegram');
      console.log('   2. Adicione o bot como administrador');
      console.log('   3. Envie uma mensagem qualquer no canal');
      console.log('   4. Execute este script novamente\n');
      process.exit(0);
    }
    
    // 3. Extrair chat_ids únicos
    const chats = new Map();
    
    data.result.forEach(update => {
      const chat = update.message?.chat || 
                   update.channel_post?.chat ||
                   update.my_chat_member?.chat;
      
      if (chat) {
        const chatType = chat.type;
        const chatTitle = chat.title || chat.first_name || 'Unknown';
        const chatId = chat.id;
        
        chats.set(chatId, {
          id: chatId,
          type: chatType,
          title: chatTitle
        });
      }
    });
    
    // 4. Exibir resultados
    console.log('📋 CHATS ENCONTRADOS:\n');
    
    let channelFound = false;
    
    chats.forEach((chat, id) => {
      const emoji = chat.type === 'channel' ? '📢' : 
                    chat.type === 'supergroup' ? '👥' : 
                    chat.type === 'group' ? '👥' : '💬';
      
      console.log(`${emoji} ${chat.title}`);
      console.log(`   Tipo: ${chat.type}`);
      console.log(`   Chat ID: ${chat.id}`);
      
      if (chat.type === 'channel' || chat.type === 'supergroup') {
        console.log(`   ✅ PODE SER USADO PARA WARMUP`);
        channelFound = true;
      } else {
        console.log(`   ⚠️  Não recomendado para warmup`);
      }
      
      console.log('');
    });
    
    // 5. Gerar comando curl
    if (channelFound) {
      const firstChannel = Array.from(chats.values())
        .find(c => c.type === 'channel' || c.type === 'supergroup');
      
      if (firstChannel) {
        console.log('\n🚀 COMANDO PARA CONFIGURAR WARMUP:\n');
        console.log(`curl -X PUT http://localhost:3000/api/admin/bots/${botSlug}/warmup-chat \\`);
        console.log(`  -H "Authorization: Bearer ${process.env.ADMIN_API_TOKEN}" \\`);
        console.log(`  -H "Content-Type: application/json" \\`);
        console.log(`  -d '{"warmup_chat_id":"${firstChannel.id}"}'`);
        console.log('');
      }
    } else {
      console.log('⚠️  Nenhum canal/supergrupo encontrado.');
      console.log('\n💡 Crie um canal privado e adicione o bot como admin.\n');
    }
    
  } catch (err) {
    console.error('❌ ERRO:', err.message);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

// Main
const botSlug = process.argv[2];

if (!botSlug) {
  console.log('Uso: node scripts/get-chat-id.js <bot_slug>');
  console.log('Exemplo: node scripts/get-chat-id.js vipshadriee_bot');
  process.exit(1);
}

getChatId(botSlug);
