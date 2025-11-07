/**
 * Multi-Media Selector Acceptance Tests
 * Tests for the complete multi-media implementation
 */

const request = require('supertest');
const { getPgPool } = require('../lib/db');

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';

describe('Multi-Media Selector Implementation', () => {
  let pool;
  let testBot;
  let testMediaRefs;

  beforeAll(async () => {
    pool = await getPgPool();
    
    // Create test bot
    const botResult = await pool.query(
      `INSERT INTO public.bots (name, slug, token, created_at) 
       VALUES ($1, $2, $3, now()) 
       RETURNING *`,
      ['Test Multi-Media Bot', 'test-multi-media-bot', 'test-token-123']
    );
    testBot = botResult.rows[0];

    // Create test media references
    testMediaRefs = [
      {
        sha256: 'a'.repeat(64),
        kind: 'audio',
        r2_key: 'test/audio.mp3',
        name: 'test-audio.mp3',
        bytes: 1024000,
        status: 'ready'
      },
      {
        sha256: 'b'.repeat(64),
        kind: 'video',
        r2_key: 'test/video.mp4',
        name: 'test-video.mp4',
        bytes: 5120000,
        status: 'ready'
      },
      {
        sha256: 'c'.repeat(64),
        kind: 'photo',
        r2_key: 'test/photo.jpg',
        name: 'test-photo.jpg',
        bytes: 512000,
        status: 'ready'
      }
    ];
  });

  afterAll(async () => {
    if (pool) {
      await pool.query('DELETE FROM public.bots WHERE slug = $1', [testBot.slug]);
      await pool.end();
    }
  });

  describe('Start Message API', () => {
    test('should save start message with multiple media refs', async () => {
      const payload = {
        active: true,
        message: {
          text: 'Test message with multiple media',
          parse_mode: 'MarkdownV2'
        },
        start_media_refs: testMediaRefs
      };

      const response = await request(BASE_URL)
        .put(`/api/admin/bots/${testBot.slug}/start-message`)
        .send(payload)
        .expect(200);

      expect(response.body.ok).toBe(true);
      expect(response.body.active).toBe(true);
      expect(response.body.start_media_refs).toHaveLength(3);
      expect(response.body.start_media_refs[0].kind).toBe('audio');
      expect(response.body.start_media_refs[1].kind).toBe('video');
      expect(response.body.start_media_refs[2].kind).toBe('photo');
    });

    test('should retrieve start message with media refs', async () => {
      const response = await request(BASE_URL)
        .get(`/api/admin/bots/${testBot.slug}/start-message`)
        .expect(200);

      expect(response.body.ok).toBe(true);
      expect(response.body.active).toBe(true);
      expect(response.body.start_media_refs).toHaveLength(3);
    });

    test('should validate media refs array size', async () => {
      const tooManyMediaRefs = [...testMediaRefs, ...testMediaRefs]; // 6 items

      const response = await request(BASE_URL)
        .put(`/api/admin/bots/${testBot.slug}/start-message`)
        .send({
          active: true,
          message: { text: 'Test', parse_mode: 'MarkdownV2' },
          start_media_refs: tooManyMediaRefs
        })
        .expect(400);

      expect(response.body.error).toBe('START_MEDIA_REFS_MAX_3');
    });

    test('should validate media ref structure', async () => {
      const invalidMediaRefs = [
        {
          sha256: 'invalid',
          kind: 'invalid-type'
        }
      ];

      const response = await request(BASE_URL)
        .put(`/api/admin/bots/${testBot.slug}/start-message`)
        .send({
          active: true,
          message: { text: 'Test', parse_mode: 'MarkdownV2' },
          start_media_refs: invalidMediaRefs
        })
        .expect(400);

      expect(response.body.error).toBe('INVALID_MEDIA_SHA256');
    });
  });

  describe('Downsell API', () => {
    test('should create downsell with multiple media refs', async () => {
      const payload = {
        name: 'Test Downsell with Media',
        content: {
          text: 'Downsell message with media',
          parse_mode: 'MarkdownV2'
        },
        media_refs: testMediaRefs.slice(0, 2), // audio + video
        delay_minutes: 5,
        active: true
      };

      const response = await request(BASE_URL)
        .post(`/api/admin/bots/${testBot.slug}/downsells`)
        .send(payload)
        .expect(200);

      expect(response.body.ok).toBe(true);
      expect(response.body.media_refs).toHaveLength(2);
      expect(response.body.media_refs[0].kind).toBe('audio');
      expect(response.body.media_refs[1].kind).toBe('video');
    });

    test('should update downsell media refs', async () => {
      // First create a downsell
      const createResponse = await request(BASE_URL)
        .post(`/api/admin/bots/${testBot.slug}/downsells`)
        .send({
          name: 'Test Downsell for Update',
          content: { text: 'Original message', parse_mode: 'MarkdownV2' },
          media_refs: [],
          delay_minutes: 5
        })
        .expect(200);

      const downsellId = createResponse.body.id;

      // Update with media refs
      const updateResponse = await request(BASE_URL)
        .put(`/api/admin/bots/${testBot.slug}/downsells/${downsellId}`)
        .send({
          media_refs: testMediaRefs.slice(1, 3) // video + photo
        })
        .expect(200);

      expect(updateResponse.body.media_refs).toHaveLength(2);
      expect(updateResponse.body.media_refs[0].kind).toBe('video');
      expect(updateResponse.body.media_refs[1].kind).toBe('photo');
    });
  });

  describe('Shot API', () => {
    test('should create shot with multiple media refs', async () => {
      const payload = {
        title: 'Test Shot with Media',
        content: {
          text: 'Broadcast message with media',
          parse_mode: 'MarkdownV2'
        },
        media_refs: testMediaRefs,
        trigger: 'now'
      };

      const response = await request(BASE_URL)
        .post(`/api/admin/bots/${testBot.slug}/shots`)
        .send(payload)
        .expect(200);

      expect(response.body.ok).toBe(true);
      expect(response.body.media_refs).toHaveLength(3);
    });
  });

  describe('Multi-Media Send Service', () => {
    const { sendMultipleMedias, sortByPriority } = require('../lib/multiMediaSendService');

    test('should sort media by priority (audio > video > photo)', () => {
      const unsortedMedia = [
        { kind: 'photo', sha256: 'c'.repeat(64) },
        { kind: 'audio', sha256: 'a'.repeat(64) },
        { kind: 'video', sha256: 'b'.repeat(64) }
      ];

      const sorted = sortByPriority(unsortedMedia);

      expect(sorted[0].kind).toBe('audio');
      expect(sorted[1].kind).toBe('video');
      expect(sorted[2].kind).toBe('photo');
    });

    test('should handle empty media refs array', async () => {
      const result = await sendMultipleMedias(pool, {
        slug: testBot.slug,
        chat_id: '123456789',
        media_refs: [],
        purpose: 'test'
      });

      expect(result.ok).toBe(true);
      expect(result.results).toHaveLength(0);
    });

    test('should validate media refs array size', async () => {
      const tooManyMediaRefs = [...testMediaRefs, ...testMediaRefs];

      await expect(
        sendMultipleMedias(pool, {
          slug: testBot.slug,
          chat_id: '123456789',
          media_refs: tooManyMediaRefs,
          purpose: 'test'
        })
      ).rejects.toThrow('TOO_MANY_MEDIA_REFS');
    });
  });

  describe('Metrics Service', () => {
    const { observe, getMetrics } = require('../lib/metricsService');

    test('should record multi-media metrics', () => {
      observe('multi_media_send_ms', 1500, {
        bot: testBot.slug,
        media_count: 3
      });

      observe('media_send_attempt_ms', 800, {
        bot: testBot.slug,
        kind: 'audio'
      });

      observe('media_send_error', 1, {
        bot: testBot.slug,
        kind: 'video',
        error: 'MEDIA_NOT_READY'
      });

      const metrics = getMetrics();

      expect(metrics.multi_media.send_ms[`${testBot.slug}:3`]).toBeDefined();
      expect(metrics.multi_media.attempt_ms[`${testBot.slug}:audio`]).toBeDefined();
      expect(metrics.multi_media.error_total[`${testBot.slug}:video:MEDIA_NOT_READY`]).toBe(1);
    });
  });

  describe('Media Prewarm Worker', () => {
    const { enqueuePrewarm, getQueueMetrics } = require('../lib/mediaPrewarmWorker');

    test('should enqueue media with explicit priority', async () => {
      const result = enqueuePrewarm({
        bot_slug: testBot.slug,
        sha256: 'd'.repeat(64),
        kind: 'audio',
        r2_key: 'test/audio2.mp3',
        priority: 300 // High priority for audio
      });

      expect(result).toBe(true);

      const metrics = getQueueMetrics();
      expect(metrics.queue_size).toBeGreaterThan(0);
    });
  });
});

describe('Multi-Media UI Integration', () => {
  describe('Multi-Media Selector Component', () => {
    // These would be browser/integration tests
    // For now, we'll test the component structure

    test('should have correct component structure', () => {
      const fs = require('fs');
      const componentPath = '../public/admin/multi-media-selector.js';
      
      expect(fs.existsSync(componentPath)).toBe(true);
      
      const componentContent = fs.readFileSync(componentPath, 'utf8');
      
      // Check for key methods
      expect(componentContent).toContain('constructor');
      expect(componentContent).toContain('initialize');
      expect(componentContent).toContain('loadMedia');
      expect(componentContent).toContain('addMedia');
      expect(componentContent).toContain('removeMedia');
      expect(componentContent).toContain('moveMedia');
      expect(componentContent).toContain('filterByType');
      expect(componentContent).toContain('getSelectedMedia');
      
      // Check for drag and drop functionality
      expect(componentContent).toContain('dragstart');
      expect(componentContent).toContain('dragover');
      expect(componentContent).toContain('drop');
      
      // Check for priority sorting
      expect(componentContent).toContain('sortByPriority');
    });
  });

  test('should be included in admin HTML', () => {
    const fs = require('fs');
    const indexPath = '../public/admin/index.html';
    
    const htmlContent = fs.readFileSync(indexPath, 'utf8');
    
    // Check for multi-media selector containers
    expect(htmlContent).toContain('start-message-multi-media-container');
    expect(htmlContent).toContain('downsell-multi-media-container');
    
    // Check for script inclusion
    expect(htmlContent).toContain('multi-media-selector.js');
  });

  test('should be included in shots modals', () => {
    const fs = require('fs');
    const shotsPath = '../shots-modals.html';
    
    const htmlContent = fs.readFileSync(shotsPath, 'utf8');
    
    // Check for multi-media selector container
    expect(htmlContent).toContain('shot-multi-media-container');
  });
});
