// backend/services/ipDocs.js
// PDF documents of a Sort_IPS register (Check list items, PGTA results of
// Crio embrio, …). They are kept apart from the editable tabs, in the section
// "docs" of sort_ip_sections:  { [docKey]: { url, uploaded_at } }
// and saved the moment the upload finishes (no "Guardar cambios" needed).
//
// Cloudinary layout (raw files, one folder per IP):
//   sort-ip-documents/ip_<ipId>/ip_<ipId>_<docKey>
// Uploading again for the same document overwrites it.

import cloudinary from '../config/cloudinary.js';
import pool from '../db.js';
import { parseCloudinaryUrl } from './seguroComprobantes.js';

export const IP_DOCS_ROOT = 'sort-ip-documents';
export const DOC_KEY_REGEX = /^[a-z0-9_]{1,80}$/;

export const ipDocFolder = (ipId) => `${IP_DOCS_ROOT}/ip_${ipId}`;
export const ipDocPublicId = (ipId, docKey) => `ip_${ipId}_${docKey}`;

const parse = (v) => {
  if (!v) return {};
  if (typeof v === 'object') return v;
  try { return JSON.parse(v) || {}; } catch { return {}; }
};

export const ipExists = async (ipId) => {
  const [rows] = await pool.query('SELECT id FROM sort_ip_candidates WHERE id = ?', [ipId]);
  return rows.length > 0;
};

export const readDocs = async (ipId) => {
  const [rows] = await pool.query(
    "SELECT data FROM sort_ip_sections WHERE candidate_id = ? AND section = 'docs'", [ipId]
  );
  return parse(rows[0]?.data);
};

/** Sets (doc = { url, uploaded_at }) or removes (doc = null) one document. Returns all docs. */
export const writeDoc = async (ipId, docKey, doc, userId) => {
  const docs = await readDocs(ipId);
  if (doc) docs[docKey] = doc; else delete docs[docKey];
  await pool.query(
    `INSERT INTO sort_ip_sections (candidate_id, section, data, updated_by)
     VALUES (?, 'docs', ?, ?)
     ON DUPLICATE KEY UPDATE data = VALUES(data), updated_by = VALUES(updated_by)`,
    [ipId, JSON.stringify(docs), userId || null]
  );
  await pool.query('UPDATE sort_ip_candidates SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', [ipId]);
  return docs;
};

/** Best-effort removal from Cloudinary (uses the stored URL's exact public id). */
export const destroyIpDoc = async (ipId, docKey, storedUrl) => {
  const parsed = parseCloudinaryUrl(storedUrl);
  try {
    await cloudinary.uploader.destroy(
      parsed?.publicId || ipDocPublicId(ipId, docKey),
      { resource_type: parsed?.resourceType || 'raw', type: parsed?.type || 'upload', invalidate: true }
    );
  } catch (err) {
    console.warn('Cloudinary IP doc delete warning:', err?.message || err);
  }
};