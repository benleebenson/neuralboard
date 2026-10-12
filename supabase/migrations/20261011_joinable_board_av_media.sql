-- Joinable boards share video and narration as well as images. Video and audio upload directly
-- from the browser through signed upload URLs (/api/joinable-board/media/upload-url); images are
-- still converted to webp server-side. 50 MB matches SHARED_AV_MAX_BYTES in lib/joinable-board.ts
-- and the default project-wide Storage upload limit; images keep their own 15 MB check in the API.
update storage.buckets
set file_size_limit = 52428800,
    allowed_mime_types = array[
      'image/webp',
      'video/mp4', 'video/webm', 'video/quicktime',
      'audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/aac', 'audio/wav', 'audio/x-wav', 'audio/wave',
      'audio/webm', 'audio/ogg', 'audio/flac'
    ]
where id = 'joinable-board-media';
