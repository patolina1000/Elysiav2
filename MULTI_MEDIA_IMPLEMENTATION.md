# Multi-Media Selector Implementation

## Overview

Complete implementation of multi-media selector support for the admin interface, allowing selection of 1-3 media items (audio, video, photo) with reordering and priority handling.

## Features Implemented

### ✅ Admin UI Components
- **Multi-Media Selector Component** (`public/admin/multi-media-selector.js`)
  - Drag and drop reordering
  - Filter by media type (audio/video/photo)
  - Visual preview with thumbnails
  - Priority sorting (audio > video > photo)
  - Maximum 3 items validation
  - Search functionality
  - Responsive design

### ✅ Database Schema Updates
- **Start Messages**: Added `start_media_refs` JSONB column to `bots` table
- **Downsells**: Added `media_refs` JSONB column to `bot_downsells` table  
- **Shots**: Added `media_refs` JSONB column to `shots` table
- **Media References Structure**: Each item contains `sha256`, `kind`, `r2_key`, `name`, `bytes`, `status`

### ✅ Backend API Updates

#### Start Message API (`/api/admin/bots/:slug/start-message`)
- Accepts `start_media_refs` array with validation
- Max 3 media items per message
- Validates SHA256 format and media kind
- Stores media refs separately from message content

#### Downsell API (`/api/admin/bots/:slug/downsells`)
- Create/Update endpoints accept `media_refs` array
- Same validation and limits as start messages
- Backward compatibility with existing content

#### Shot API (`/api/admin/bots/:slug/shots`)
- Create endpoint accepts `media_refs` array
- Supports both `content` and `message` fields for compatibility

### ✅ Sending Orchestration

#### Multi-Media Send Service (`lib/multiMediaSendService.js`)
- **Priority Ordering**: Audio > Video > Photo
- **Separate Messages**: Each media sent as individual message (no captions)
- **Fallback Handling**: Graceful degradation on media failures
- **Cache Integration**: Uses existing media cache and pre-warm system
- **Error Handling**: Detailed logging and metrics

#### Worker Updates
- **Start Messages** (`server.js`): Updated webhook handler for multi-media
- **Downsell Worker** (`lib/downsellWorker.js`): Processes media refs arrays
- **Shot Worker** (`lib/shotWorker.js`): Handles multi-media broadcasts
- **Legacy Support**: Maintains compatibility with single media format

### ✅ Cache & Pre-warm System

#### Media Prewarm Worker (`lib/mediaPrewarmWorker.js`)
- **Priority System**: Audio (300) > Photo (200) > Video (100)
- **Explicit Priority**: Supports manual priority specification
- **Queue Optimization**: O(1) operations with priority sorting
- **Parallel Processing**: Up to 5 concurrent pre-warm jobs

#### Cache Service (`lib/mediaService.js`)
- **Multi-Media Support**: Handles arrays of media references
- **Status Tracking**: Individual status per media item
- **Efficient Lookup**: Optimized cache queries for multiple items

### ✅ Metrics & Monitoring

#### Metrics Service (`lib/metricsService.js`)
- **Multi-Media Metrics**:
  - `multi_media_send_ms`: Total send time by media count
  - `media_send_attempt_ms`: Individual media send attempts by kind
  - `media_send_error`: Error counts by kind and error type
- **Dashboard Integration**: New multi-media section in metrics API
- **Performance Tracking**: P95/P99 latencies for multi-media operations

#### Logging Enhancements
- **Structured Logs**: Consistent logging across all components
- **Request IDs**: Trace operations across services
- **Success/Failure Tracking**: Detailed status reporting
- **Performance Metrics**: Timing for each operation phase

## API Examples

### Start Message with Multi-Media
```json
PUT /api/admin/bots/mybot/start-message
{
  "active": true,
  "message": {
    "text": "Welcome! Check out these media files:",
    "parse_mode": "MarkdownV2"
  },
  "start_media_refs": [
    {
      "sha256": "abcdef123456...",
      "kind": "audio",
      "r2_key": "audio/welcome.mp3",
      "name": "welcome.mp3",
      "bytes": 1024000,
      "status": "ready"
    },
    {
      "sha256": "123456abcdef...",
      "kind": "video", 
      "r2_key": "video/intro.mp4",
      "name": "intro.mp4",
      "bytes": 5120000,
      "status": "ready"
    },
    {
      "sha256": "fedcba654321...",
      "kind": "photo",
      "r2_key": "photo/banner.jpg", 
      "name": "banner.jpg",
      "bytes": 512000,
      "status": "ready"
    }
  ]
}
```

### Downsell with Multi-Media
```json
POST /api/admin/bots/mybot/downsells
{
  "name": "Special Offer Downsell",
  "content": {
    "text": "Don't miss this special offer!",
    "parse_mode": "MarkdownV2"
  },
  "media_refs": [
    {
      "sha256": "abc123...",
      "kind": "photo",
      "r2_key": "photos/offer.jpg",
      "name": "offer.jpg",
      "bytes": 256000,
      "status": "ready"
    }
  ],
  "delay_minutes": 5,
  "active": true
}
```

## Sending Behavior

### Priority Order
1. **Audio** (highest priority - sent first)
2. **Video** (medium priority)
3. **Photo** (lowest priority - sent last)

### Message Flow
1. Media items sent in priority order as separate messages
2. Text message sent after all media (if configured)
3. Each media item has independent success/failure handling
4. Failed media doesn't prevent other media or text from sending

### Error Handling
- **Cache Miss**: Automatic pre-warm enqueue and retry
- **Upload Failure**: Graceful fallback, continue with other media
- **Validation Errors**: Clear error messages with specific codes
- **Rate Limits**: Respects existing rate limiting per bot

## Database Schema

### bots Table
```sql
ALTER TABLE public.bots 
ADD COLUMN start_media_refs JSONB DEFAULT '[]';
```

### bot_downsells Table
```sql
ALTER TABLE public.bot_downsells 
ADD COLUMN media_refs JSONB DEFAULT '[]';
```

### shots Table
```sql
ALTER TABLE public.shots 
ADD COLUMN media_refs JSONB DEFAULT '[]';
```

## Testing

### Acceptance Tests (`test/multiMedia.test.js`)
- **API Validation**: Test all endpoints with valid/invalid data
- **Priority Sorting**: Verify audio > video > photo ordering
- **Error Handling**: Test validation and error scenarios
- **Metrics**: Verify metric collection and reporting
- **UI Integration**: Component structure and inclusion tests

### Test Coverage
- ✅ Start Message API (save, retrieve, validation)
- ✅ Downsell API (create, update, validation)
- ✅ Shot API (create with media refs)
- ✅ Multi-Media Send Service (sorting, validation, error handling)
- ✅ Metrics Service (recording, retrieval)
- ✅ Media Prewarm Worker (priority enqueue)
- ✅ UI Components (structure, inclusion)

## Performance Considerations

### Optimizations Implemented
- **Parallel Pre-warm**: Up to 5 concurrent media preparations
- **Priority Queue**: O(1) operations with automatic sorting
- **Cache Efficiency**: Reuse existing cache infrastructure
- **Batch Operations**: Efficient database queries for arrays
- **Memory Management**: Limited queue sizes and cleanup

### Expected Performance
- **Media Send**: 200-800ms per media item (cached)
- **Pre-warm**: 1-3 seconds for new media
- **API Response**: <100ms for validation/save operations
- **UI Interaction**: <50ms for drag/drop operations

## Backward Compatibility

### Legacy Support
- Single media format still supported via `content.media` object
- Existing API clients continue to work unchanged
- Database migrations are additive (no breaking changes)
- Worker processes handle both old and new formats

### Migration Path
1. Deploy backend updates (backward compatible)
2. Update admin UI with multi-media selector
3. Gradually migrate existing content to new format
4. Eventually deprecate single media format (future release)

## Monitoring & Debugging

### Key Metrics to Monitor
- `multi_media_send_ms_p95`: Total send time by media count
- `media_send_attempt_ms_p95`: Individual media send performance
- `media_send_error_total`: Error rates by media type
- `media_prewarm_queue_size`: Pre-warm system health

### Debug Information
- Request IDs trace operations across services
- Detailed logs for each media item processed
- Cache hit/miss ratios per media type
- Priority queue metrics and processing times

## Security Considerations

### Validation
- SHA256 format validation (64 hex characters)
- Media kind whitelist (audio, video, photo)
- Maximum array size enforcement (3 items)
- SQL injection protection via parameterized queries

### Access Control
- Existing admin authentication preserved
- Media access controlled by existing R2 permissions
- No new attack surfaces introduced

## Future Enhancements

### Potential Improvements
- **Album Support**: Send media as grouped albums
- **Caption Support**: Individual captions per media item
- **Preview Generation**: Automatic thumbnails for videos
- **Compression**: On-the-fly media optimization
- **Analytics**: Media engagement tracking

### Scalability
- **Distributed Processing**: Multiple pre-warm workers
- **CDN Integration**: Edge caching for popular media
- **Smart Pre-warm**: Predictive media preparation
- **Batch Sending**: Bulk media operations for large broadcasts

## Deployment Notes

### Required Changes
1. **Database**: Run migration scripts to add JSONB columns
2. **Environment**: No new environment variables required
3. **Dependencies**: All dependencies already exist
4. **Configuration**: No configuration changes needed

### Rollback Plan
- Database columns are nullable with default values
- UI changes are additive (no breaking changes)
- API endpoints maintain backward compatibility
- Can be safely rolled back by reverting code deployment

## Summary

This implementation provides a complete, production-ready multi-media selector system with:

- **Full Feature Set**: All requested functionality implemented
- **High Performance**: Optimized for speed and efficiency
- **Robust Error Handling**: Graceful degradation and detailed logging
- **Comprehensive Testing**: Full test coverage for all components
- **Backward Compatibility**: Seamless migration from existing system
- **Monitoring & Observability**: Complete metrics and debugging support

The system is ready for production deployment and can handle the expected load while maintaining excellent performance and reliability.
