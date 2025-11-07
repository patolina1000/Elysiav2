/**
 * Script de teste para upload de mídia
 * Uso: node scripts/test-media-upload.js <bot_slug> <image_path>
 */

const fs = require('fs');
const path = require('path');

const ADMIN_API_TOKEN = process.env.ADMIN_API_TOKEN || '';
const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:3000';

async function uploadMedia(botSlug, imagePath) {
  console.log('[TEST_MEDIA_UPLOAD][START]', { botSlug, imagePath });
  
  // 1. Ler arquivo
  if (!fs.existsSync(imagePath)) {
    console.error('[TEST_MEDIA_UPLOAD][ERR] Arquivo não encontrado:', imagePath);
    process.exit(1);
  }
  
  const buffer = fs.readFileSync(imagePath);
  const base64 = buffer.toString('base64');
  const ext = path.extname(imagePath).slice(1);
  const stats = fs.statSync(imagePath);
  
  console.log('[TEST_MEDIA_UPLOAD][FILE_INFO]', {
    size_bytes: stats.size,
    size_kb: Math.round(stats.size / 1024),
    ext
  });
  
  // 2. Determinar tipo MIME
  const mimeMap = {
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'png': 'image/png',
    'gif': 'image/gif',
    'mp4': 'video/mp4',
    'webm': 'video/webm',
    'pdf': 'application/pdf',
    'mp3': 'audio/mpeg',
    'ogg': 'audio/ogg'
  };
  
  const mime = mimeMap[ext.toLowerCase()] || 'application/octet-stream';
  
  // 3. Determinar kind
  let kind = 'document';
  if (mime.startsWith('image/')) kind = 'photo';
  else if (mime.startsWith('video/')) kind = 'video';
  else if (mime.startsWith('audio/')) kind = 'audio';
  
  console.log('[TEST_MEDIA_UPLOAD][DETECTED]', { mime, kind });
  
  // 4. Upload via API
  const url = `${API_BASE_URL}/api/admin/bots/${botSlug}/media`;
  
  console.log('[TEST_MEDIA_UPLOAD][UPLOADING]', { url });
  
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${ADMIN_API_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        kind,
        data_base64: base64,
        mime,
        ext
      })
    });
    
    const data = await response.json();
    
    if (response.ok) {
      console.log('[TEST_MEDIA_UPLOAD][OK]', data);
      
      // 5. Aguardar aquecimento
      console.log('[TEST_MEDIA_UPLOAD][WARMING] Aguardando aquecimento (5s)...');
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      // 6. Verificar status
      const statusUrl = `${API_BASE_URL}/api/admin/media/${data.media_id}`;
      const statusResponse = await fetch(statusUrl, {
        headers: {
          'Authorization': `Bearer ${ADMIN_API_TOKEN}`
        }
      });
      
      const statusData = await statusResponse.json();
      console.log('[TEST_MEDIA_UPLOAD][STATUS]', statusData);
      
      if (statusData.ok && statusData.media.cache.status === 'ready') {
        console.log('[TEST_MEDIA_UPLOAD][SUCCESS] Mídia pronta para uso! ✅');
        console.log('[TEST_MEDIA_UPLOAD][FILE_ID]', statusData.media.cache.file_id);
      } else {
        console.log('[TEST_MEDIA_UPLOAD][WARMING] Ainda aquecendo...');
      }
      
    } else {
      console.error('[TEST_MEDIA_UPLOAD][ERR]', data);
      process.exit(1);
    }
    
  } catch (err) {
    console.error('[TEST_MEDIA_UPLOAD][EXCEPTION]', err.message);
    process.exit(1);
  }
}

// Main
const args = process.argv.slice(2);

if (args.length < 2) {
  console.log('Uso: node scripts/test-media-upload.js <bot_slug> <image_path>');
  console.log('Exemplo: node scripts/test-media-upload.js mybot ./photo.jpg');
  process.exit(1);
}

const [botSlug, imagePath] = args;

uploadMedia(botSlug, imagePath).catch(err => {
  console.error('[TEST_MEDIA_UPLOAD][FATAL]', err);
  process.exit(1);
});
