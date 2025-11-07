require('dotenv').config();
const { Client } = require('pg');
const fs = require('fs');
const path = require('path');

async function run() {
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  
  await client.connect();
  
  try {
    // Ler arquivo SQL
    const sql = fs.readFileSync(path.join('./migrations', '014_multi_media_support.sql'), 'utf8');
    
    // Executar comandos separadamente para evitar problema com CHECK constraints
    const commands = [
      `ALTER TABLE public.bots ADD COLUMN IF NOT EXISTS start_media_refs jsonb DEFAULT '[]'::jsonb;`,
      `ALTER TABLE public.bot_downsells ADD COLUMN IF NOT EXISTS media_refs jsonb DEFAULT '[]'::jsonb;`,
      `ALTER TABLE public.shots ADD COLUMN IF NOT EXISTS media_refs jsonb DEFAULT '[]'::jsonb;`,
      `COMMENT ON COLUMN public.bots.start_media_refs IS 'Array de referências de mídia para /start (máx 3 itens): [{"sha256": "...", "kind": "audio|video|photo"}, ...]';`,
      `COMMENT ON COLUMN public.bot_downsells.media_refs IS 'Array de referências de mídia para downsell (máx 3 itens): [{"sha256": "...", "kind": "audio|video|photo"}, ...]';`,
      `COMMENT ON COLUMN public.shots.media_refs IS 'Array de referências de mídia para disparo (máx 3 itens): [{"sha256": "...", "kind": "audio|video|photo"}, ...]';`,
      `CREATE INDEX IF NOT EXISTS ix_bots_start_media_refs ON public.bots USING GIN (start_media_refs) WHERE start_media_refs != '[]'::jsonb;`,
      `CREATE INDEX IF NOT EXISTS ix_bot_downsells_media_refs ON public.bot_downsells USING GIN (media_refs) WHERE media_refs != '[]'::jsonb;`,
      `CREATE INDEX IF NOT EXISTS ix_shots_media_refs ON public.shots USING GIN (media_refs) WHERE media_refs != '[]'::jsonb;`
    ];
    
    for (const cmd of commands) {
      await client.query(cmd);
      console.log(`✅ Comando executado`);
    }
    
    console.log('\n✅ Migração 014_multi_media_support.sql aplicada com sucesso');
    
  } catch (err) {
    console.error('❌ Erro:', err.message);
    process.exit(1);
  }
  
  await client.end();
}

run().catch(err => {
  console.error('❌ Erro:', err.message);
  process.exit(1);
});
