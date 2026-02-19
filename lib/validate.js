/**
 * Validates an extension .zip file contents.
 * Checks for required files, manifest structure, and security concerns.
 */

const ALLOWED_PERMISSIONS = [
  'storage', 'network', 'tabs', 'ai', 'music',
  'popups', 'cross_storage', 'cross_storage_write'
];

const ALLOWED_CATEGORIES = [
  'productivity', 'utilities', 'developer', 'media',
  'social', 'crypto', 'games', 'security'
];

const ALLOWED_TYPES = ['sidebar', 'popup', 'background'];

function validateManifest(manifest) {
  const errors = [];
  const warnings = [];

  // Required fields
  if (!manifest.name || typeof manifest.name !== 'string') errors.push('Missing or invalid "name" field');
  if (!manifest.version || !/^\d+\.\d+\.\d+$/.test(manifest.version)) errors.push('Missing or invalid "version" (must be semver x.y.z)');
  if (!manifest.description || typeof manifest.description !== 'string') errors.push('Missing or invalid "description" field');
  if (!manifest.author || typeof manifest.author !== 'string') errors.push('Missing or invalid "author" field');
  if (!manifest.main || typeof manifest.main !== 'string') errors.push('Missing or invalid "main" entry file');

  // Optional but validated
  if (manifest.type && !ALLOWED_TYPES.includes(manifest.type)) {
    errors.push(`Invalid "type": ${manifest.type}. Must be one of: ${ALLOWED_TYPES.join(', ')}`);
  }

  if (manifest.permissions) {
    if (!Array.isArray(manifest.permissions)) {
      errors.push('"permissions" must be an array');
    } else {
      const unknown = manifest.permissions.filter(p => !ALLOWED_PERMISSIONS.includes(p));
      if (unknown.length) errors.push(`Unknown permissions: ${unknown.join(', ')}`);

      // Security warnings
      if (manifest.permissions.includes('network')) warnings.push('Extension requests NETWORK access — can make external HTTP requests');
      if (manifest.permissions.includes('cross_storage_write')) warnings.push('Extension requests CROSS_STORAGE_WRITE — can write to other extensions\' storage');
      if (manifest.permissions.includes('tabs')) warnings.push('Extension requests TABS access — can open new browser tabs');
    }
  }

  // Name length
  if (manifest.name && manifest.name.length > 50) errors.push('Name must be 50 characters or less');
  if (manifest.description && manifest.description.length > 300) errors.push('Description must be 300 characters or less');

  return { valid: errors.length === 0, errors, warnings };
}

function validateFiles(fileList) {
  const errors = [];
  const warnings = [];

  const hasManifest = fileList.some(f => f === 'manifest.json' || f.endsWith('/manifest.json'));
  if (!hasManifest) errors.push('Missing manifest.json in root of zip');

  const hasMain = fileList.some(f => f.endsWith('.jsx') || f.endsWith('.js') || f.endsWith('.html'));
  if (!hasMain) errors.push('No entry file found (.jsx, .js, or .html)');

  // Security checks
  const suspicious = fileList.filter(f =>
    f.endsWith('.exe') || f.endsWith('.dll') || f.endsWith('.bat') ||
    f.endsWith('.cmd') || f.endsWith('.sh') || f.endsWith('.ps1') ||
    f.endsWith('.node') || f.endsWith('.wasm')
  );
  if (suspicious.length) errors.push(`Forbidden file types found: ${suspicious.join(', ')}`);

  // Size warnings
  if (fileList.length > 50) warnings.push(`Large extension: ${fileList.length} files`);

  return { valid: errors.length === 0, errors, warnings };
}

module.exports = { validateManifest, validateFiles, ALLOWED_PERMISSIONS, ALLOWED_CATEGORIES, ALLOWED_TYPES };
