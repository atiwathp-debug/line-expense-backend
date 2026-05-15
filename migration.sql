-- Run this SQL in Supabase SQL Editor (https://supabase.com/dashboard/project/sopycdhltyfhlgibsdcb/sql)
-- before deploying the updated backend.

ALTER TABLE expenses ADD COLUMN IF NOT EXISTS project_id text;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS image_url text;

CREATE TABLE IF NOT EXISTS projects (
  id uuid default gen_random_uuid() primary key,
  name text not null unique,
  description text,
  color text default '#06c755',
  created_at timestamptz default now()
);

ALTER TABLE projects ENABLE ROW LEVEL SECURITY;

-- Allow service role full access (backend uses service key, which bypasses RLS automatically,
-- but explicit policy keeps things clean for future anon/user access patterns)
CREATE POLICY "Service role access" ON projects
  USING (true)
  WITH CHECK (true);
