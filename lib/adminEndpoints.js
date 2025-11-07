/**
 * Endpoints Admin para downsells e disparos
 * Para ser integrado no server.js
 */

const { 
  listDownsells, 
  createDownsell, 
  updateDownsell, 
  deleteDownsell,
  getDownsellStats 
} = require('./downsellService');

const {
  listShots,
  getShot,
  createShot,
  updateShot,
  deleteShot,
  duplicateShot,
  populateShotQueue,
  startShot,
  cancelShot
} = require('./shotService');

function genReqId() {
  return (Date.now().toString(36) + '-' + require('crypto').randomUUID()).toLowerCase();
}

/**
 * Registra endpoints de downsells
 */
function registerDownsellEndpoints(app, requireAdmin, getPgPool) {
  // Listar downsells de um bot
  app.get('/api/admin/bots/:slug/downsells', requireAdmin, async (req, res) => {
    const request_id = genReqId();
    const slug = (req.params.slug || '').trim();
    
    if (!slug) {
      return res.status(400).json({ ok: false, error: 'MISSING_SLUG' });
    }
    
    const pool = await getPgPool();
    if (!pool) {
      return res.status(503).json({ ok: false, error: 'DATABASE_NOT_AVAILABLE' });
    }
    
    try {
      const downsells = await listDownsells(pool, slug);
      console.info('[ADMIN][DOWNSELLS][LIST]', { request_id, slug, count: downsells.length });
      return res.json({ ok: true, downsells });
    } catch (err) {
      console.error('[ADMIN][DOWNSELLS][LIST][ERR]', { request_id, slug, error: err.message });
      return res.status(500).json({ ok: false, error: 'LIST_FAILED' });
    }
  });

  // Criar downsell
  app.post('/api/admin/bots/:slug/downsells', requireAdmin, async (req, res) => {
    const request_id = genReqId();
    const slug = (req.params.slug || '').trim();
    const { name, content, delay_seconds, delay_minutes, active, after_start, after_pix } = req.body || {};
    
    if (!slug) {
      return res.status(400).json({ ok: false, error: 'MISSING_SLUG' });
    }
    
    const pool = await getPgPool();
    if (!pool) {
      return res.status(503).json({ ok: false, error: 'DATABASE_NOT_AVAILABLE' });
    }
    
    try {
      // Suportar delay_seconds (legado) ou delay_minutes (novo)
      const finalDelayMinutes = delay_minutes !== undefined 
        ? delay_minutes 
        : (delay_seconds !== undefined ? Math.round(delay_seconds / 60) : 20);
      
      const downsell = await createDownsell(pool, {
        slug,
        name,
        content,
        delay_minutes: finalDelayMinutes,
        active,
        after_start: after_start !== undefined ? after_start : true,
        after_pix: after_pix !== undefined ? after_pix : false
      });
      
      console.info('[ADMIN][DOWNSELLS][CREATE]', { request_id, slug, downsell_id: downsell.id });
      return res.status(201).json({ ok: true, downsell });
    } catch (err) {
      console.error('[ADMIN][DOWNSELLS][CREATE][ERR]', { request_id, slug, error: err.message });
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Atualizar downsell
  app.put('/api/admin/bots/:slug/downsells/:id', requireAdmin, async (req, res) => {
    const request_id = genReqId();
    const slug = (req.params.slug || '').trim();
    const id = parseInt(req.params.id, 10);
    const { name, content, delay_seconds, delay_minutes, active, after_start, after_pix } = req.body || {};
    
    if (!slug || !id) {
      return res.status(400).json({ ok: false, error: 'MISSING_PARAMS' });
    }
    
    const pool = await getPgPool();
    if (!pool) {
      return res.status(503).json({ ok: false, error: 'DATABASE_NOT_AVAILABLE' });
    }
    
    try {
      const updateParams = {
        name,
        content,
        active,
        after_start,
        after_pix
      };
      
      // Suportar delay_seconds (legado) ou delay_minutes (novo)
      if (delay_minutes !== undefined) {
        updateParams.delay_minutes = delay_minutes;
      } else if (delay_seconds !== undefined) {
        updateParams.delay_minutes = Math.round(delay_seconds / 60);
      }
      
      const downsell = await updateDownsell(pool, id, updateParams);
      
      console.info('[ADMIN][DOWNSELLS][UPDATE]', { request_id, slug, downsell_id: id });
      return res.json({ ok: true, downsell });
    } catch (err) {
      console.error('[ADMIN][DOWNSELLS][UPDATE][ERR]', { request_id, slug, id, error: err.message });
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Deletar downsell
  app.delete('/api/admin/bots/:slug/downsells/:id', requireAdmin, async (req, res) => {
    const request_id = genReqId();
    const slug = (req.params.slug || '').trim();
    const id = parseInt(req.params.id, 10);
    
    if (!slug || !id) {
      return res.status(400).json({ ok: false, error: 'MISSING_PARAMS' });
    }
    
    const pool = await getPgPool();
    if (!pool) {
      return res.status(503).json({ ok: false, error: 'DATABASE_NOT_AVAILABLE' });
    }
    
    try {
      const deleted = await deleteDownsell(pool, id);
      
      if (deleted) {
        console.info('[ADMIN][DOWNSELLS][DELETE]', { request_id, slug, downsell_id: id });
        return res.json({ ok: true, deleted: true });
      } else {
        return res.status(404).json({ ok: false, error: 'DOWNSELL_NOT_FOUND' });
      }
    } catch (err) {
      console.error('[ADMIN][DOWNSELLS][DELETE][ERR]', { request_id, slug, id, error: err.message });
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Estatísticas de downsells
  app.get('/api/admin/bots/:slug/downsells/stats', requireAdmin, async (req, res) => {
    const request_id = genReqId();
    const slug = (req.params.slug || '').trim();
    
    if (!slug) {
      return res.status(400).json({ ok: false, error: 'MISSING_SLUG' });
    }
    
    const pool = await getPgPool();
    if (!pool) {
      return res.status(503).json({ ok: false, error: 'DATABASE_NOT_AVAILABLE' });
    }
    
    try {
      const stats = await getDownsellStats(pool, slug);
      console.info('[ADMIN][DOWNSELLS][STATS]', { request_id, slug, stats });
      return res.json({ ok: true, stats });
    } catch (err) {
      console.error('[ADMIN][DOWNSELLS][STATS][ERR]', { request_id, slug, error: err.message });
      return res.status(500).json({ ok: false, error: 'STATS_FAILED' });
    }
  });

  // Testar downsell
  app.post('/api/admin/bots/:slug/downsells/test', requireAdmin, async (req, res) => {
    const request_id = genReqId();
    const slug = (req.params.slug || '').trim();
    const { downsell_id, telegram_id, trigger, transaction_id, respect_delay } = req.body || {};
    
    if (!slug || !downsell_id || !telegram_id || !trigger) {
      return res.status(400).json({ ok: false, error: 'MISSING_PARAMS' });
    }
    
    if (trigger === 'pix' && !transaction_id) {
      return res.status(400).json({ ok: false, error: 'TRANSACTION_ID_REQUIRED_FOR_PIX' });
    }
    
    const pool = await getPgPool();
    if (!pool) {
      return res.status(503).json({ ok: false, error: 'DATABASE_NOT_AVAILABLE' });
    }
    
    try {
      const { scheduleDownsellsForStart, scheduleDownsellsForPix } = require('./downsellService');
      
      let scheduled = 0;
      const now = new Date();
      
      if (trigger === 'start') {
        scheduled = await scheduleDownsellsForStart(pool, {
          bot_slug: slug,
          telegram_id: parseInt(telegram_id, 10),
          correlation_id: `test-${request_id}`,
          now: respect_delay === 'true' || respect_delay === true ? now : null,
          downsell_id_filter: parseInt(downsell_id, 10)
        });
      } else if (trigger === 'pix') {
        scheduled = await scheduleDownsellsForPix(pool, {
          bot_slug: slug,
          telegram_id: parseInt(telegram_id, 10),
          transaction_id,
          correlation_id: `test-${request_id}`,
          now: respect_delay === 'true' || respect_delay === true ? now : null,
          downsell_id_filter: parseInt(downsell_id, 10)
        });
      }
      
      console.info('[ADMIN][DOWNSELLS][TEST]', { 
        request_id, slug, downsell_id, telegram_id, trigger, scheduled 
      });
      
      return res.json({ 
        ok: true, 
        scheduled,
        message: scheduled > 0 
          ? `Downsell agendado com sucesso. Será enviado ${respect_delay ? 'respeitando o delay configurado' : 'agora'}.`
          : 'Nenhum downsell foi agendado. Verifique se o downsell está ativo e se há PIX não pago.'
      });
    } catch (err) {
      console.error('[ADMIN][DOWNSELLS][TEST][ERR]', { request_id, slug, error: err.message });
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Ativar/desativar downsell (toggle)
  app.patch('/api/admin/bots/:slug/downsells/:id/toggle', requireAdmin, async (req, res) => {
    const request_id = genReqId();
    const slug = (req.params.slug || '').trim();
    const id = parseInt(req.params.id, 10);
    
    if (!slug || !id) {
      return res.status(400).json({ ok: false, error: 'MISSING_PARAMS' });
    }
    
    const pool = await getPgPool();
    if (!pool) {
      return res.status(503).json({ ok: false, error: 'DATABASE_NOT_AVAILABLE' });
    }
    
    try {
      // Buscar estado atual
      const current = await pool.query(
        'SELECT active FROM public.bot_downsells WHERE id = $1 AND slug = $2',
        [id, slug]
      );
      
      if (current.rowCount === 0) {
        return res.status(404).json({ ok: false, error: 'DOWNSELL_NOT_FOUND' });
      }
      
      const newActive = !current.rows[0].active;
      
      // Atualizar
      const downsell = await updateDownsell(pool, id, { active: newActive });
      
      console.info('[ADMIN][DOWNSELLS][TOGGLE]', { request_id, slug, downsell_id: id, active: newActive });
      return res.json({ ok: true, downsell });
    } catch (err) {
      console.error('[ADMIN][DOWNSELLS][TOGGLE][ERR]', { request_id, slug, id, error: err.message });
      return res.status(500).json({ ok: false, error: err.message });
    }
  });
}

/**
 * Registra endpoints de disparos
 */
function registerShotEndpoints(app, requireAdmin, getPgPool) {
  // Listar disparos de um bot
  app.get('/api/admin/bots/:slug/shots', requireAdmin, async (req, res) => {
    const request_id = genReqId();
    const slug = (req.params.slug || '').trim();
    
    if (!slug) {
      return res.status(400).json({ ok: false, error: 'MISSING_SLUG' });
    }
    
    const pool = await getPgPool();
    if (!pool) {
      return res.status(503).json({ ok: false, error: 'DATABASE_NOT_AVAILABLE' });
    }
    
    try {
      const shots = await listShots(pool, slug);
      console.info('[ADMIN][SHOTS][LIST]', { request_id, slug, count: shots.length });
      return res.json({ ok: true, shots });
    } catch (err) {
      console.error('[ADMIN][SHOTS][LIST][ERR]', { request_id, slug, error: err.message });
      return res.status(500).json({ ok: false, error: 'LIST_FAILED' });
    }
  });

  // Obter detalhes de um disparo
  app.get('/api/admin/bots/:slug/shots/:id', requireAdmin, async (req, res) => {
    const request_id = genReqId();
    const slug = (req.params.slug || '').trim();
    const id = parseInt(req.params.id, 10);
    
    if (!slug || !id) {
      return res.status(400).json({ ok: false, error: 'MISSING_PARAMS' });
    }
    
    const pool = await getPgPool();
    if (!pool) {
      return res.status(503).json({ ok: false, error: 'DATABASE_NOT_AVAILABLE' });
    }
    
    try {
      const shot = await getShot(pool, id);
      console.info('[ADMIN][SHOTS][GET]', { request_id, slug, shot_id: id });
      return res.json({ ok: true, shot });
    } catch (err) {
      console.error('[ADMIN][SHOTS][GET][ERR]', { request_id, slug, id, error: err.message });
      
      if (err.message === 'SHOT_NOT_FOUND') {
        return res.status(404).json({ ok: false, error: 'SHOT_NOT_FOUND' });
      }
      
      return res.status(500).json({ ok: false, error: 'GET_FAILED' });
    }
  });

  // Criar disparo
  app.post('/api/admin/bots/:slug/shots', requireAdmin, async (req, res) => {
    const request_id = genReqId();
    const slug = (req.params.slug || '').trim();
    const { title, content, message, parse_mode, trigger, scheduled_at, filters, created_by } = req.body || {};
    
    if (!slug) {
      return res.status(400).json({ ok: false, error: 'MISSING_SLUG' });
    }
    
    const pool = await getPgPool();
    if (!pool) {
      return res.status(503).json({ ok: false, error: 'DATABASE_NOT_AVAILABLE' });
    }
    
    try {
      const shot = await createShot(pool, {
        slug,
        title,
        content,  // ✅ Aceita 'content' (novo padrão)
        message,  // Mantém 'message' para compatibilidade
        parse_mode,
        trigger,
        scheduled_at,
        filters,
        created_by
      });
      
      console.info('[ADMIN][SHOTS][CREATE]', { 
        request_id, 
        slug, 
        shot_id: shot.id,
        trigger,
        scheduled_at 
      });
      
      // ✅ Se for disparo imediato (trigger: 'now'), inicia automaticamente
      if (trigger === 'now') {
        try {
          // PostgreSQL retorna bigserial como string, converter para int
          console.log('[DEBUG][AUTO_START][1] shot.id recebido:', { 
            id: shot.id, 
            type: typeof shot.id,
            isString: typeof shot.id === 'string',
            isNumber: typeof shot.id === 'number'
          });
          
          const shotIdInt = parseInt(shot.id, 10);
          
          console.log('[DEBUG][AUTO_START][2] Após parseInt:', { 
            shotIdInt, 
            type: typeof shotIdInt,
            isNaN: isNaN(shotIdInt),
            original: shot.id
          });
          
          const targetCount = await startShot(pool, shotIdInt);
          
          console.info('[ADMIN][SHOTS][AUTO_START]', {
            request_id,
            slug,
            shot_id: shotIdInt,
            target_count: targetCount
          });
          
          // Retorna o shot atualizado com status 'sending'
          const updatedShot = await getShot(pool, shotIdInt);
          return res.status(201).json({ ok: true, shot: updatedShot, auto_started: true });
        } catch (startErr) {
          console.error('[ADMIN][SHOTS][AUTO_START][ERR]', {
            request_id,
            slug,
            shot_id: shot.id,
            error: startErr.message,
            errorName: startErr.name,
            errorCode: startErr.code
          });
          console.error('[DEBUG][AUTO_START][ERR] Stack trace:', startErr.stack);
          console.error('[DEBUG][AUTO_START][ERR] Erro completo:', startErr);
          
          // Retorna o shot criado mesmo se o auto-start falhar
          return res.status(201).json({ ok: true, shot, auto_start_error: startErr.message });
        }
      }
      
      return res.status(201).json({ ok: true, shot });
    } catch (err) {
      console.error('[ADMIN][SHOTS][CREATE][ERR]', { request_id, slug, error: err.message });
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Popular fila de um disparo
  app.post('/api/admin/bots/:slug/shots/:id/populate', requireAdmin, async (req, res) => {
    const request_id = genReqId();
    const slug = (req.params.slug || '').trim();
    const id = parseInt(req.params.id, 10);
    
    if (!slug || !id) {
      return res.status(400).json({ ok: false, error: 'MISSING_PARAMS' });
    }
    
    const pool = await getPgPool();
    if (!pool) {
      return res.status(503).json({ ok: false, error: 'DATABASE_NOT_AVAILABLE' });
    }
    
    try {
      const count = await populateShotQueue(pool, id);
      console.info('[ADMIN][SHOTS][POPULATE]', { request_id, slug, shot_id: id, count });
      return res.json({ ok: true, count });
    } catch (err) {
      console.error('[ADMIN][SHOTS][POPULATE][ERR]', { request_id, slug, id, error: err.message });
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Atualizar disparo
  app.put('/api/admin/bots/:slug/shots/:id', requireAdmin, async (req, res) => {
    const request_id = genReqId();
    const slug = (req.params.slug || '').trim();
    const id = parseInt(req.params.id, 10);
    const updates = req.body || {};
    
    if (!slug || !id) {
      return res.status(400).json({ ok: false, error: 'MISSING_PARAMS' });
    }
    
    const pool = await getPgPool();
    if (!pool) {
      return res.status(503).json({ ok: false, error: 'DATABASE_NOT_AVAILABLE' });
    }
    
    try {
      const shot = await updateShot(pool, id, updates);
      console.info('[ADMIN][SHOTS][UPDATE]', { request_id, slug, shot_id: id });
      return res.json({ ok: true, shot });
    } catch (err) {
      console.error('[ADMIN][SHOTS][UPDATE][ERR]', { request_id, slug, id, error: err.message });
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Deletar disparo
  app.delete('/api/admin/bots/:slug/shots/:id', requireAdmin, async (req, res) => {
    const request_id = genReqId();
    const slug = (req.params.slug || '').trim();
    const id = parseInt(req.params.id, 10);
    
    if (!slug || !id) {
      return res.status(400).json({ ok: false, error: 'MISSING_PARAMS' });
    }
    
    const pool = await getPgPool();
    if (!pool) {
      return res.status(503).json({ ok: false, error: 'DATABASE_NOT_AVAILABLE' });
    }
    
    try {
      const deleted = await deleteShot(pool, id);
      
      if (deleted) {
        console.info('[ADMIN][SHOTS][DELETE]', { request_id, slug, shot_id: id });
        return res.json({ ok: true, deleted: true });
      } else {
        return res.status(400).json({ ok: false, error: 'CANNOT_DELETE' });
      }
    } catch (err) {
      console.error('[ADMIN][SHOTS][DELETE][ERR]', { request_id, slug, id, error: err.message });
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Duplicar disparo
  app.post('/api/admin/bots/:slug/shots/:id/duplicate', requireAdmin, async (req, res) => {
    const request_id = genReqId();
    const slug = (req.params.slug || '').trim();
    const id = parseInt(req.params.id, 10);
    
    if (!slug || !id) {
      return res.status(400).json({ ok: false, error: 'MISSING_PARAMS' });
    }
    
    const pool = await getPgPool();
    if (!pool) {
      return res.status(503).json({ ok: false, error: 'DATABASE_NOT_AVAILABLE' });
    }
    
    try {
      const shot = await duplicateShot(pool, id);
      console.info('[ADMIN][SHOTS][DUPLICATE]', { request_id, slug, original_id: id, new_id: shot.id });
      return res.status(201).json({ ok: true, shot });
    } catch (err) {
      console.error('[ADMIN][SHOTS][DUPLICATE][ERR]', { request_id, slug, id, error: err.message });
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Iniciar disparo (popula fila e começa envio)
  app.post('/api/admin/bots/:slug/shots/:id/start', requireAdmin, async (req, res) => {
    const request_id = genReqId();
    const slug = (req.params.slug || '').trim();
    const id = parseInt(req.params.id, 10);
    
    if (!slug || !id) {
      return res.status(400).json({ ok: false, error: 'MISSING_PARAMS' });
    }
    
    const pool = await getPgPool();
    if (!pool) {
      return res.status(503).json({ ok: false, error: 'DATABASE_NOT_AVAILABLE' });
    }
    
    try {
      const count = await startShot(pool, id);
      console.info('[ADMIN][SHOTS][START]', { request_id, slug, shot_id: id, target_count: count });
      return res.json({ ok: true, started: true, target_count: count });
    } catch (err) {
      console.error('[ADMIN][SHOTS][START][ERR]', { request_id, slug, id, error: err.message });
      return res.status(500).json({ ok: false, error: err.message });
    }
  });

  // Cancelar disparo
  app.post('/api/admin/bots/:slug/shots/:id/cancel', requireAdmin, async (req, res) => {
    const request_id = genReqId();
    const slug = (req.params.slug || '').trim();
    const id = parseInt(req.params.id, 10);
    
    if (!slug || !id) {
      return res.status(400).json({ ok: false, error: 'MISSING_PARAMS' });
    }
    
    const pool = await getPgPool();
    if (!pool) {
      return res.status(503).json({ ok: false, error: 'DATABASE_NOT_AVAILABLE' });
    }
    
    try {
      const canceled = await cancelShot(pool, id);
      
      if (canceled) {
        console.info('[ADMIN][SHOTS][CANCEL]', { request_id, slug, shot_id: id });
        return res.json({ ok: true, canceled: true });
      } else {
        return res.status(400).json({ ok: false, error: 'CANNOT_CANCEL' });
      }
    } catch (err) {
      console.error('[ADMIN][SHOTS][CANCEL][ERR]', { request_id, slug, id, error: err.message });
      return res.status(500).json({ ok: false, error: err.message });
    }
  });
}

module.exports = {
  registerDownsellEndpoints,
  registerShotEndpoints
};
