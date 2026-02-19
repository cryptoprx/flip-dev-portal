const express = require('express');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const Busboy = require('busboy');
const { put, del } = require('@vercel/blob');
const db = require('../lib/db');
const { validateManifest, validateFiles, ALLOWED_CATEGORIES } = require('../lib/validate');

const app = express();
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use('/public', express.static(path.join(__dirname, '..', 'public')));

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const ADMIN_USER = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASSWORD || 'admin';

let tablesReady = false;
app.use(async (req, res, next) => {
  if (!tablesReady) { await db.ensureTables(); tablesReady = true; }
  next();
});

// ── Cookie helpers ───────────────────────────────────────────
function getToken(req) {
  const cookie = req.headers.cookie || '';
  const match = cookie.match(/admin_token=([^;]+)/);
  return match ? match[1] : null;
}
function verifyAdmin(req) {
  try { return jwt.verify(getToken(req), JWT_SECRET); } catch { return null; }
}

// ============================================================
// PUBLIC — Landing page (shows approved marketplace extensions)
// ============================================================
const MARKETPLACE_URL = 'https://peru-grasshopper-236853.hostingersite.com/marketplace-packages/marketplace.json';

app.get('/', async (req, res) => {
  let extensions = [];
  try {
    const resp = await fetch(MARKETPLACE_URL, { signal: AbortSignal.timeout(5000) });
    if (resp.ok) {
      const data = await resp.json();
      extensions = (data.extensions || []).filter(e => e.approved);
    }
  } catch (err) {
    console.error('Failed to fetch marketplace:', err.message);
  }
  res.render('landing', { extensions });
});

// ============================================================
// DOCS — Extension guidelines
// ============================================================
app.get('/docs', (req, res) => {
  res.render('docs');
});

// ============================================================
// DEVELOPER — Submit extension
// ============================================================
app.get('/submit', (req, res) => {
  res.render('submit', { error: null, success: null, categories: ALLOWED_CATEGORIES });
});

app.post('/submit', async (req, res) => {
  try {
    const chunks = [];
    let fields = {};
    let fileName = '';
    let fileSize = 0;

    await new Promise((resolve, reject) => {
      const busboy = Busboy({
        headers: req.headers,
        limits: { fileSize: 10 * 1024 * 1024 } // 10MB max
      });

      busboy.on('field', (name, val) => { fields[name] = val; });
      busboy.on('file', (name, file, info) => {
        fileName = info.filename;
        file.on('data', d => { chunks.push(d); fileSize += d.length; });
        file.on('end', () => {});
      });
      busboy.on('finish', resolve);
      busboy.on('error', reject);
      req.pipe(busboy);
    });

    if (!chunks.length) {
      return res.render('submit', { error: 'No file uploaded.', success: null, categories: ALLOWED_CATEGORIES });
    }
    if (!fileName.endsWith('.zip')) {
      return res.render('submit', { error: 'Only .zip files are accepted.', success: null, categories: ALLOWED_CATEGORIES });
    }

    const buffer = Buffer.concat(chunks);

    // Parse zip to find manifest.json and file list
    const { manifest, fileList } = await parseZipContents(buffer);

    if (!manifest) {
      return res.render('submit', { error: 'No manifest.json found in zip root. Each extension must include a manifest.json.', success: null, categories: ALLOWED_CATEGORIES });
    }

    // Validate manifest
    const manifestResult = validateManifest(manifest);
    if (!manifestResult.valid) {
      return res.render('submit', { error: `Manifest errors: ${manifestResult.errors.join('; ')}`, success: null, categories: ALLOWED_CATEGORIES });
    }

    // Validate file list
    const filesResult = validateFiles(fileList);
    if (!filesResult.valid) {
      return res.render('submit', { error: `File errors: ${filesResult.errors.join('; ')}`, success: null, categories: ALLOWED_CATEGORIES });
    }

    // Generate ext_id from name
    const extId = (manifest.name || 'ext').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');

    // Upload to Vercel Blob (temporary storage for review)
    const blobName = `submissions/${extId}-${manifest.version}-${Date.now()}.zip`;
    const blob = await put(blobName, buffer, { access: 'public', contentType: 'application/zip' });

    // Save to DB
    const submission = await db.createSubmission({
      ext_id: extId,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description || fields.description || '',
      author: manifest.author || fields.author_name || 'Unknown',
      author_email: fields.author_email || null,
      category: fields.category || manifest.category || 'utilities',
      icon: manifest.icon || 'puzzle',
      type: manifest.type || 'sidebar',
      permissions: manifest.permissions || [],
      api_version: manifest.api_version || '1.0',
      blob_url: blob.url,
      manifest_json: manifest,
    });

    const warnings = [...manifestResult.warnings, ...filesResult.warnings];
    const successMsg = `Extension "${manifest.name}" v${manifest.version} submitted for review! Submission #${submission.id}` +
      (warnings.length ? `\n\nWarnings:\n• ${warnings.join('\n• ')}` : '');

    res.render('submit', { error: null, success: successMsg, categories: ALLOWED_CATEGORIES });
  } catch (err) {
    console.error('Submit error:', err);
    res.render('submit', { error: 'Upload failed: ' + err.message, success: null, categories: ALLOWED_CATEGORIES });
  }
});

// ============================================================
// ADMIN — Auth
// ============================================================
app.get('/admin/login', (req, res) => {
  if (verifyAdmin(req)) return res.redirect('/admin');
  res.render('admin-login', { error: null });
});

app.post('/admin/login', async (req, res) => {
  const { username, password } = req.body;
  const passMatch = ADMIN_PASS.startsWith('$2') ? await bcrypt.compare(password, ADMIN_PASS) : password === ADMIN_PASS;
  if (username === ADMIN_USER && passMatch) {
    const token = jwt.sign({ admin: true }, JWT_SECRET, { expiresIn: '24h' });
    res.setHeader('Set-Cookie', `admin_token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400`);
    return res.redirect('/admin');
  }
  res.render('admin-login', { error: 'Invalid credentials' });
});

app.get('/admin/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'admin_token=; Path=/; HttpOnly; Max-Age=0');
  res.redirect('/admin/login');
});

// ============================================================
// ADMIN — Dashboard
// ============================================================
app.get('/admin', async (req, res) => {
  if (!verifyAdmin(req)) return res.redirect('/admin/login');
  try {
    const stats = await db.getStats();
    const pending = await db.getSubmissions('pending');
    const recent = await db.getSubmissions();
    res.render('admin-dashboard', { stats, pending, recent: recent.slice(0, 50) });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

// Admin — Review a submission
app.get('/admin/review/:id', async (req, res) => {
  if (!verifyAdmin(req)) return res.redirect('/admin/login');
  try {
    const submission = await db.getSubmissionById(req.params.id);
    if (!submission) return res.status(404).send('Not found');
    res.render('admin-review', { submission });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

// Admin — Approve
app.post('/admin/approve/:id', async (req, res) => {
  if (!verifyAdmin(req)) return res.status(401).send('Unauthorized');
  try {
    const { review_notes } = req.body;
    await db.updateSubmissionStatus(req.params.id, 'approved', review_notes || 'Approved');
    res.redirect('/admin');
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

// Admin — Reject
app.post('/admin/reject/:id', async (req, res) => {
  if (!verifyAdmin(req)) return res.redirect('/admin/login');
  try {
    const { review_notes } = req.body;
    await db.updateSubmissionStatus(req.params.id, 'rejected', review_notes || 'Rejected');
    res.redirect('/admin');
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});

// ============================================================
// API — Submission status check
// ============================================================
app.get('/api/status/:id', async (req, res) => {
  try {
    const sub = await db.getSubmissionById(req.params.id);
    if (!sub) return res.status(404).json({ error: 'Not found' });
    res.json({ id: sub.id, name: sub.name, version: sub.version, status: sub.status, review_notes: sub.review_notes });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// ============================================================
// Zip parsing helper (minimal, no external dep)
// ============================================================
async function parseZipContents(buffer) {
  // Simple zip file parser — reads central directory to get file list + manifest
  const fileList = [];
  let manifest = null;

  try {
    // Find End of Central Directory record
    let eocdOffset = -1;
    for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65557); i--) {
      if (buffer.readUInt32LE(i) === 0x06054b50) { eocdOffset = i; break; }
    }
    if (eocdOffset < 0) throw new Error('Invalid zip file');

    const cdEntries = buffer.readUInt16LE(eocdOffset + 10);
    let cdOffset = buffer.readUInt32LE(eocdOffset + 16);

    for (let i = 0; i < cdEntries; i++) {
      if (buffer.readUInt32LE(cdOffset) !== 0x02014b50) break;
      const fnLen = buffer.readUInt16LE(cdOffset + 28);
      const extraLen = buffer.readUInt16LE(cdOffset + 30);
      const commentLen = buffer.readUInt16LE(cdOffset + 32);
      const localOffset = buffer.readUInt32LE(cdOffset + 42);
      const fileName = buffer.toString('utf-8', cdOffset + 46, cdOffset + 46 + fnLen);

      if (!fileName.endsWith('/')) fileList.push(fileName);

      // Extract manifest.json from local file header
      if ((fileName === 'manifest.json' || fileName.match(/^[^/]+\/manifest\.json$/)) && !manifest) {
        const lfhOffset = localOffset;
        if (buffer.readUInt32LE(lfhOffset) === 0x04034b50) {
          const lfnLen = buffer.readUInt16LE(lfhOffset + 26);
          const lextraLen = buffer.readUInt16LE(lfhOffset + 28);
          const compMethod = buffer.readUInt16LE(lfhOffset + 8);
          const compSize = buffer.readUInt32LE(lfhOffset + 18);
          const dataStart = lfhOffset + 30 + lfnLen + lextraLen;

          if (compMethod === 0) { // stored (not compressed)
            const raw = buffer.toString('utf-8', dataStart, dataStart + compSize);
            try { manifest = JSON.parse(raw); } catch {}
          }
          // For deflate, we'd need zlib — skip for now, most small manifests are stored
        }
      }

      cdOffset += 46 + fnLen + extraLen + commentLen;
    }
  } catch (e) {
    console.error('Zip parse error:', e.message);
  }

  // Normalize file paths (strip leading folder name if all files share one)
  if (fileList.length && !fileList.some(f => f === 'manifest.json')) {
    const prefix = fileList[0].split('/')[0] + '/';
    if (fileList.every(f => f.startsWith(prefix))) {
      const stripped = fileList.map(f => f.slice(prefix.length));
      return { manifest, fileList: stripped };
    }
  }

  return { manifest, fileList };
}

module.exports = app;
