const { sql } = require('@vercel/postgres');

// ── Bootstrap ────────────────────────────────────────────────
async function ensureTables() {
  await sql`
    CREATE TABLE IF NOT EXISTS customers (
      id              SERIAL PRIMARY KEY,
      firebase_uid    TEXT UNIQUE NOT NULL,
      email           TEXT,
      stripe_customer TEXT UNIQUE,
      created_at      TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  await sql`
    CREATE TABLE IF NOT EXISTS entitlements (
      id              SERIAL PRIMARY KEY,
      firebase_uid    TEXT NOT NULL,
      ext_id          TEXT NOT NULL,
      stripe_sub_id   TEXT,
      stripe_price_id TEXT,
      plan_type       TEXT NOT NULL DEFAULT 'monthly',
      status          TEXT NOT NULL DEFAULT 'active',
      expires_at      TIMESTAMPTZ,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(firebase_uid, ext_id)
    )
  `;
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

// ── Customers ────────────────────────────────────────────────
async function getOrCreateCustomer(firebaseUid, email) {
  const { rows } = await sql`
    SELECT * FROM customers WHERE firebase_uid = ${firebaseUid}
  `;
  if (rows[0]) return rows[0];
  const { rows: created } = await sql`
    INSERT INTO customers (firebase_uid, email)
    VALUES (${firebaseUid}, ${email})
    ON CONFLICT (firebase_uid) DO UPDATE SET email = EXCLUDED.email
    RETURNING *
  `;
  return created[0];
}

async function getOrCreateCustomerByEmail(email) {
  const { rows } = await sql`
    SELECT * FROM customers WHERE email = ${email}
  `;
  if (rows[0]) return rows[0];
  // Use email as a pseudo firebase_uid for email-only customers
  const uid = 'email_' + Buffer.from(email).toString('base64url');
  const { rows: created } = await sql`
    INSERT INTO customers (firebase_uid, email)
    VALUES (${uid}, ${email})
    ON CONFLICT (firebase_uid) DO UPDATE SET email = EXCLUDED.email
    RETURNING *
  `;
  return created[0];
}

async function updateCustomerStripe(firebaseUid, stripeCustomerId) {
  await sql`
    UPDATE customers SET stripe_customer = ${stripeCustomerId}
    WHERE firebase_uid = ${firebaseUid}
  `;
}

async function getCustomerByStripe(stripeCustomerId) {
  const { rows } = await sql`
    SELECT * FROM customers WHERE stripe_customer = ${stripeCustomerId}
  `;
  return rows[0];
}

// ── Entitlements ─────────────────────────────────────────────
async function createEntitlement(data) {
  const { rows } = await sql`
    INSERT INTO entitlements (firebase_uid, ext_id, stripe_sub_id, stripe_price_id, plan_type, status, expires_at)
    VALUES (${data.firebase_uid}, ${data.ext_id}, ${data.stripe_sub_id || null}, ${data.stripe_price_id || null}, ${data.plan_type || 'monthly'}, ${data.status || 'active'}, ${data.expires_at || null})
    ON CONFLICT (firebase_uid, ext_id) DO UPDATE SET
      stripe_sub_id = EXCLUDED.stripe_sub_id,
      stripe_price_id = EXCLUDED.stripe_price_id,
      plan_type = EXCLUDED.plan_type,
      status = EXCLUDED.status,
      expires_at = EXCLUDED.expires_at,
      updated_at = NOW()
    RETURNING *
  `;
  return rows[0];
}

async function getEntitlements(firebaseUid) {
  const { rows } = await sql`
    SELECT * FROM entitlements WHERE firebase_uid = ${firebaseUid} AND status = 'active'
  `;
  return rows;
}

async function getEntitlementsByEmail(email) {
  const { rows } = await sql`
    SELECT e.* FROM entitlements e
    JOIN customers c ON c.firebase_uid = e.firebase_uid
    WHERE c.email = ${email} AND e.status = 'active'
  `;
  return rows;
}

async function updateEntitlementBySubscription(stripeSubId, status) {
  await sql`
    UPDATE entitlements SET status = ${status}, updated_at = NOW()
    WHERE stripe_sub_id = ${stripeSubId}
  `;
}

async function revokeEntitlement(firebaseUid, extId) {
  await sql`
    UPDATE entitlements SET status = 'revoked', updated_at = NOW()
    WHERE firebase_uid = ${firebaseUid} AND ext_id = ${extId}
  `;
}

module.exports = {
  ensureTables, createSubmission, getSubmissions, getSubmissionById, updateSubmissionStatus, getStats,
  getOrCreateCustomer, getOrCreateCustomerByEmail, updateCustomerStripe, getCustomerByStripe,
  createEntitlement, getEntitlements, getEntitlementsByEmail, updateEntitlementBySubscription, revokeEntitlement,
};
