-- Joinable-board images now upload straight from the browser through signed upload URLs
-- (/api/joinable-board/media/upload-url) instead of through a Vercel function, which rejected
-- anything over its 4.5 MB request body limit with a 413. The browser shrinks large photos to JPEG
-- first; GIFs (animated), PNG, WebP and HEIC it can't decode upload as they are. Matches
-- SHARED_IMAGE_EXTENSIONS in lib/joinable-board.ts. No image/svg+xml: SVG can carry script.
update storage.buckets
set allowed_mime_types = array[
      'image/webp', 'image/jpeg', 'image/png', 'image/gif', 'image/heic', 'image/heif',
      'video/mp4', 'video/webm', 'video/quicktime',
      'audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/wav', 'audio/x-wav', 'audio/wave',
      'audio/webm', 'audio/ogg', 'audio/flac'
    ]
where id = 'joinable-board-media';
