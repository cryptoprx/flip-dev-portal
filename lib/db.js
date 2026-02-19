const { sql } = require('@vercel/postgres');

// ── Bootstrap ────────────────────────────────────────────────
async function ensureTables() {
  await sql`
    CREATE TABLE IF NOT EXISTS submissions (
      id            SERIAL PRIMARY KEY,
      ext_id        TEXT NOT NULL,
      name          TEXT NOT NULL,
      version       TEXT NOT NULL DEFAULT '1.0.0',
      description   TEXT,
      author        TEXT NOT NULL,
      author_email  TEXT,
      category      TEXT NOT NULL DEFAULT 'utilities',
      icon          TEXT DEFAULT 'puzzle',
      type          TEXT DEFAULT 'sidebar',
      permissions   TEXT[] DEFAULT '{}',
      api_version   TEXT DEFAULT '1.0',
      author_website TEXT,
      author_github  TEXT,
      author_twitter TEXT,
      author_discord TEXT,
      blob_url      TEXT,
      manifest_json JSONB,
      status        TEXT NOT NULL DEFAULT 'pending',
      review_notes  TEXT,
      created_at    TIMESTAMPTZ DEFAULT NOW(),
      reviewed_at   TIMESTAMPTZ
    )
  `;
}

// ── Submissions ──────────────────────────────────────────────
async function createSubmission(data) {
  const { rows } = await sql`
    INSERT INTO submissions (ext_id, name, version, description, author, author_email, author_website, author_github, author_twitter, author_discord, category, icon, type, permissions, api_version, blob_url, manifest_json)
    VALUES (${data.ext_id}, ${data.name}, ${data.version}, ${data.description}, ${data.author}, ${data.author_email || null}, ${data.author_website || null}, ${data.author_github || null}, ${data.author_twitter || null}, ${data.author_discord || null}, ${data.category}, ${data.icon || 'puzzle'}, ${data.type || 'sidebar'}, ${data.permissions || []}, ${data.api_version || '1.0'}, ${data.blob_url}, ${JSON.stringify(data.manifest_json || {})})
    RETURNING *
  `;
  return rows[0];
}

async function getSubmissions(status = null) {
  if (status) {
    const { rows } = await sql`SELECT * FROM submissions WHERE status = ${status} ORDER BY created_at DESC`;
    return rows;
  }
  const { rows } = await sql`SELECT * FROM submissions ORDER BY created_at DESC`;
  return rows;
}

async function getSubmissionById(id) {
  const { rows } = await sql`SELECT * FROM submissions WHERE id = ${id}`;
  return rows[0];
}

async function updateSubmissionStatus(id, status, reviewNotes = null) {
  const { rows } = await sql`
    UPDATE submissions SET status = ${status}, review_notes = ${reviewNotes}, reviewed_at = NOW()
    WHERE id = ${id} RETURNING *
  `;
  return rows[0];
}

async function getStats() {
  const { rows } = await sql`
    SELECT
      COUNT(*) as total,
      COUNT(*) FILTER (WHERE status = 'pending') as pending,
      COUNT(*) FILTER (WHERE status = 'approved') as approved,
      COUNT(*) FILTER (WHERE status = 'rejected') as rejected
    FROM submissions
  `;
  return rows[0];
}

module.exports = { ensureTables, createSubmission, getSubmissions, getSubmissionById, updateSubmissionStatus, getStats };
