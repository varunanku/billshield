-- Server-side upload limits on the bills bucket, enforced by Supabase
-- Storage itself (the browser uploads straight to storage, so this is the
-- check a client can't skip): 20 MB max -- the same cap /api/bills/extract
-- uses -- and only the four bill file types the app accepts.
-- /api/bills/extract additionally checks the file's own first bytes.
--
-- Idempotent: safe to run again even if already applied.
update storage.buckets
set
  file_size_limit = 20971520,
  allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
where id = 'bills';
