import cloudinary from '../config/cloudinary.js';
import { logActivity, logUpdate, logCreate, logDelete, logLogin, logLogout, ACTIVITY_TYPES, ENTITY_TYPES } from '../services/activityLogger.js';
import pool from '../db.js';
import {
  comprobanteFolder, comprobantePublicId, findCuota, destroyComprobante, pipeStoredPdf,
} from '../services/seguroComprobantes.js';
import {
  DOC_KEY_REGEX, ipDocFolder, ipDocPublicId, ipExists, readDocs, writeDoc, destroyIpDoc,
} from '../services/ipDocs.js';

export const getUploadSignature = async (req, res) => {
  try {
    if (!req.session || !req.session.user) {
      return res.status(401).json({ message: 'Not authenticated' });
    }

    const userId = req.session.user.id;
    const timestamp = Math.round(Date.now() / 1000);

    const folder = req.query.folder || 'default-folder';
    const publicId = `user_${userId}`;

    const signature = cloudinary.utils.api_sign_request(
      {
        timestamp,
        public_id: publicId,
        asset_folder: folder,
        overwrite: true,
        transformation: 'c_fill,w_300,h_300,g_face',
      },
      process.env.CLOUDINARY_API_SECRET
    );

    res.json({
      timestamp,
      signature,
      publicId,
      assetFolder: folder,
      cloudName: process.env.CLOUDINARY_CLOUD_NAME,
      apiKey: process.env.CLOUDINARY_API_KEY,
    });

  } catch (err) {
    console.error('SIGNATURE ERROR STACK:', err);
    res.status(500).json({ message: 'Signature generation failed' });
  }
};

// ── Candidate profile photo signature ────────────────────────
export const getCandidateUploadSignature = async (req, res) => {
  try {
    if (!req.session || !req.session.user) {
      return res.status(401).json({ message: 'Not authenticated' });
    }

    const { candidateId } = req.query;
    if (!candidateId) {
      return res.status(400).json({ message: 'candidateId is required' });
    }

    const timestamp = Math.round(Date.now() / 1000);
    const folder    = 'sort-ges-candidates';
    const publicId  = `candidate_${candidateId}`;

    const signature = cloudinary.utils.api_sign_request(
      {
        timestamp,
        public_id:    publicId,
        asset_folder: folder,
        overwrite:    true,
        transformation: 'c_fill,w_300,h_300,g_face',
      },
      process.env.CLOUDINARY_API_SECRET
    );

    res.json({
      timestamp, signature, publicId,
      assetFolder: folder,
      cloudName: process.env.CLOUDINARY_CLOUD_NAME,
      apiKey:     process.env.CLOUDINARY_API_KEY,
    });

  } catch (err) {
    console.error('CANDIDATE SIGNATURE ERROR:', err);
    res.status(500).json({ message: 'Signature generation failed' });
  }
};

// ── Stream candidate PDF through backend (bypasses untrusted restriction) ──
// Instead of giving the browser a Cloudinary URL (which fails on free accounts),
// the backend fetches the file using the Admin API and pipes it to the browser.
export const streamCandidateDoc = async (req, res) => {
  if (!req.session?.user) return res.status(401).json({ message: 'Not authenticated' });

  const { candidateId, docType } = req.query;
  if (!candidateId) return res.status(400).json({ message: 'candidateId is required' });
  if (!docType)     return res.status(400).json({ message: 'docType is required' });

  const ALLOWED = ['certificado_nacimiento', 'curp', 'comprobante_domicilio', 'poliza_seguro'];
  if (!ALLOWED.includes(docType)) return res.status(400).json({ message: 'Invalid docType' });

  try {
    const publicId = `candidate_${candidateId}_${docType}`;

    // Build a signed fetch URL using the API credentials directly
    // This hits the authenticated API endpoint, not the delivery CDN
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    const apiKey    = process.env.CLOUDINARY_API_KEY;
    const apiSecret = process.env.CLOUDINARY_API_SECRET;

    const fetchUrl =
      `https://api.cloudinary.com/v1_1/${cloudName}/resources/raw/upload/${encodeURIComponent(publicId)}`;

    // Use Basic Auth with api_key:api_secret
    const authHeader = 'Basic ' + Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');

    // First get the resource metadata to find the actual file URL
    const metaResponse = await fetch(fetchUrl, {
      headers: { Authorization: authHeader },
    });

    if (!metaResponse.ok) {
      const err = await metaResponse.json().catch(() => ({}));
      console.error('Cloudinary metadata fetch failed:', err);
      return res.status(404).json({ message: 'Document not found on Cloudinary' });
    }

    const meta = await metaResponse.json();
    const secureUrl = meta.secure_url;

    if (!secureUrl) {
      return res.status(404).json({ message: 'Document URL not available' });
    }

    // Now stream the actual file — add auth header to bypass untrusted restriction
    const fileResponse = await fetch(secureUrl, {
      headers: { Authorization: authHeader },
    });

    if (!fileResponse.ok) {
      return res.status(fileResponse.status).json({ message: 'Failed to fetch document' });
    }

    // Pipe to browser as a PDF
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${publicId}.pdf"`);

    const { Readable } = await import('stream');
    const nodeStream = Readable.fromWeb(fileResponse.body);
    nodeStream.pipe(res);

  } catch (err) {
    console.error('STREAM DOC ERROR:', err);
    res.status(500).json({ message: 'Error streaming document' });
  }
};
export const deleteCandidateDoc = async (req, res) => {
  if (!req.session?.user) return res.status(401).json({ message: 'Not authenticated' });

  const { candidateId, docType } = req.query;
  if (!candidateId) return res.status(400).json({ message: 'candidateId is required' });
  if (!docType)     return res.status(400).json({ message: 'docType is required' });

  const ALLOWED = ['certificado_nacimiento', 'curp', 'comprobante_domicilio', 'poliza_seguro'];
  if (!ALLOWED.includes(docType)) return res.status(400).json({ message: 'Invalid docType' });

  const publicId = `candidate_${candidateId}_${docType}`;

  try {
    // 1. Delete from Cloudinary (resource_type raw = PDFs)
    try {
      await cloudinary.uploader.destroy(publicId, { resource_type: 'raw', invalidate: true });
    } catch (cloudErr) {
      // Log but don't fail — the file may have already been deleted or never uploaded
      console.warn('Cloudinary delete warning:', cloudErr?.message || cloudErr);
    }

    // 2. Null the DB column via the checklist upsert logic directly in pool
    // Import pool inline — upload controller doesn't normally touch the DB
    const { default: pool } = await import('../db.js');
    const DB_COLUMN_MAP = {
      certificado_nacimiento: 'certificado_nacimiento_url',
      curp:                   'curp_url',
      comprobante_domicilio:  'comprobante_domicilio_url',
      poliza_seguro:          'poliza_seguro_url',
    };
    const dbColumn = DB_COLUMN_MAP[docType];
    await pool.query(
      `UPDATE sort_ges_checklist SET ${dbColumn} = NULL WHERE candidate_id = ?`,
      [candidateId]
    );

    res.json({ success: true });
  } catch (err) {
    console.error('DELETE DOC ERROR:', err);
    res.status(500).json({ message: 'Error deleting document' });
  }
};
// docType = 'certificado_nacimiento' | 'curp' | 'comprobante_domicilio' | 'poliza_seguro'
export const getCandidateDocUploadSignature = async (req, res) => {
  try {
    if (!req.session || !req.session.user) {
      return res.status(401).json({ message: 'Not authenticated' });
    }

    const { candidateId, docType } = req.query;
    if (!candidateId) return res.status(400).json({ message: 'candidateId is required' });
    if (!docType)     return res.status(400).json({ message: 'docType is required' });

    const allowed = ['certificado_nacimiento', 'curp', 'comprobante_domicilio', 'poliza_seguro'];
    if (!allowed.includes(docType)) {
      return res.status(400).json({ message: 'Invalid docType' });
    }

    const timestamp = Math.round(Date.now() / 1000);
    const folder    = 'sort-ges-documents';
    const publicId  = `candidate_${candidateId}_${docType}`;

    // resource_type 'raw' is NOT included in the signature params —
    // it is sent as a query param in the upload URL instead
    const signature = cloudinary.utils.api_sign_request(
      {
        timestamp,
        public_id:    publicId,
        asset_folder: folder,
        overwrite:    true,
      },
      process.env.CLOUDINARY_API_SECRET
    );

    res.json({
      timestamp, signature, publicId,
      assetFolder: folder,
      cloudName: process.env.CLOUDINARY_CLOUD_NAME,
      apiKey:     process.env.CLOUDINARY_API_KEY,
    });

  } catch (err) {
    console.error('CANDIDATE DOC SIGNATURE ERROR:', err);
    res.status(500).json({ message: 'Signature generation failed' });
  }
};


// ═════════════════════════════════════════════════════════════
// Comprobante (PDF) of each registered payment — Seguro de Gastos Médicos Mayores
// Folders and names: services/seguroComprobantes.js
// ═════════════════════════════════════════════════════════════
const parseCuotaQuery = (src) => {
  const polizaId = Number(src.polizaId);
  const cuotaNum = Number(src.cuotaNum);
  return Number.isInteger(polizaId) && polizaId > 0 && Number.isInteger(cuotaNum) && cuotaNum > 0
    ? { polizaId, cuotaNum } : null;
};

// GET /api/upload/seguro-pago-signature?polizaId&cuotaNum
export const getSeguroPagoSignature = async (req, res) => {
  if (!req.session?.user) return res.status(401).json({ message: 'Not authenticated' });
  const q = parseCuotaQuery(req.query);
  if (!q) return res.status(400).json({ message: 'polizaId y cuotaNum son obligatorios' });
  try {
    const cuota = await findCuota(q.polizaId, q.cuotaNum);
    if (!cuota) return res.status(404).json({ message: 'Cuota no encontrada' });
    if (!cuota.fecha_pago || cuota.status === 'cancelado') {
      return res.status(400).json({ message: 'Solo se puede subir el comprobante de un pago registrado' });
    }
    const timestamp = Math.round(Date.now() / 1000);
    const folder    = comprobanteFolder(cuota.candidate_id, q.polizaId);
    const publicId  = comprobantePublicId(cuota.candidate_id, q.polizaId, q.cuotaNum);
    // resource_type 'raw' goes in the upload URL, not in the signature
    const signature = cloudinary.utils.api_sign_request(
      { timestamp, public_id: publicId, asset_folder: folder, overwrite: true },
      process.env.CLOUDINARY_API_SECRET
    );
    res.json({
      timestamp, signature, publicId,
      assetFolder: folder,
      cloudName: process.env.CLOUDINARY_CLOUD_NAME,
      apiKey:    process.env.CLOUDINARY_API_KEY,
    });
  } catch (err) {
    console.error('SEGURO PAGO SIGNATURE ERROR:', err);
    res.status(500).json({ message: 'Signature generation failed' });
  }
};

// PUT /api/upload/seguro-pago-doc  { polizaId, cuotaNum, url } — saves the uploaded file's URL
export const saveSeguroPagoDoc = async (req, res) => {
  if (!req.session?.user) return res.status(401).json({ message: 'Not authenticated' });
  const q = parseCuotaQuery(req.body || {});
  const url = String(req.body?.url || '');
  if (!q) return res.status(400).json({ message: 'polizaId y cuotaNum son obligatorios' });
  // Only URLs of this Cloudinary account
  if (!url.startsWith(`https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/`)) {
    return res.status(400).json({ message: 'URL de comprobante inválida' });
  }
  try {
    const cuota = await findCuota(q.polizaId, q.cuotaNum);
    if (!cuota) return res.status(404).json({ message: 'Cuota no encontrada' });
    await pool.query(
      'UPDATE sort_ges_seguro_mat_cuotas SET comprobante_url = ? WHERE seguro_mat_id = ? AND cuota_num = ?',
      [url, q.polizaId, q.cuotaNum]
    );
    await logUpdate(req.session.user.id, 'progestor',
      `Subió comprobante de pago cuota ${q.cuotaNum} póliza #${q.polizaId}`, new Date(), `${q.polizaId}`);
    res.json({ success: true, comprobante_url: url });
  } catch (err) {
    console.error('SAVE SEGURO PAGO DOC ERROR:', err);
    res.status(500).json({ message: 'Error al guardar el comprobante' });
  }
};

// GET /api/upload/seguro-pago-stream?polizaId&cuotaNum — opens the PDF
export const streamSeguroPagoDoc = async (req, res) => {
  if (!req.session?.user) return res.status(401).json({ message: 'Not authenticated' });
  const q = parseCuotaQuery(req.query);
  if (!q) return res.status(400).json({ message: 'polizaId y cuotaNum son obligatorios' });
  try {
    const cuota = await findCuota(q.polizaId, q.cuotaNum);
    if (!cuota?.comprobante_url) return res.status(404).json({ message: 'Este pago no tiene comprobante' });
    // Uses the exact URL Cloudinary returned at upload time (saved on the payment)
    await pipeStoredPdf(res, cuota.comprobante_url, comprobantePublicId(cuota.candidate_id, q.polizaId, q.cuotaNum));
  } catch (err) {
    console.error('STREAM SEGURO PAGO DOC ERROR:', err);
    if (!res.headersSent) res.status(500).json({ message: 'Error al abrir el comprobante' });
  }
};

// DELETE /api/upload/seguro-pago-doc?polizaId&cuotaNum
export const deleteSeguroPagoDoc = async (req, res) => {
  if (!req.session?.user) return res.status(401).json({ message: 'Not authenticated' });
  const q = parseCuotaQuery(req.query);
  if (!q) return res.status(400).json({ message: 'polizaId y cuotaNum son obligatorios' });
  try {
    const cuota = await findCuota(q.polizaId, q.cuotaNum);
    if (!cuota) return res.status(404).json({ message: 'Cuota no encontrada' });
    await destroyComprobante(cuota.candidate_id, q.polizaId, q.cuotaNum, cuota.comprobante_url);
    await pool.query(
      'UPDATE sort_ges_seguro_mat_cuotas SET comprobante_url = NULL WHERE seguro_mat_id = ? AND cuota_num = ?',
      [q.polizaId, q.cuotaNum]
    );
    await logDelete(req.session.user.id, 'progestor',
      `Eliminó comprobante de pago cuota ${q.cuotaNum} póliza #${q.polizaId}`, new Date(), `${q.polizaId}`);
    res.json({ success: true });
  } catch (err) {
    console.error('DELETE SEGURO PAGO DOC ERROR:', err);
    res.status(500).json({ message: 'Error al eliminar el comprobante' });
  }
};

// ── Sort_IPS profile photo signature ─────────────────────────
// GET /api/upload/ip-cloudinary-signature?ipId — same settings as the Sort_GESCA photo
// (300×300, face crop); one file per IP, overwritten on change.
export const getIpUploadSignature = async (req, res) => {
  if (!req.session?.user) return res.status(401).json({ message: 'Not authenticated' });
  const ipId = Number(req.query.ipId);
  if (!Number.isInteger(ipId) || ipId <= 0) return res.status(400).json({ message: 'ipId is required' });
  try {
    const [rows] = await pool.query('SELECT id FROM sort_ip_candidates WHERE id = ?', [ipId]);
    if (!rows.length) return res.status(404).json({ message: 'Registro IP no encontrado' });
    const timestamp = Math.round(Date.now() / 1000);
    const folder    = 'sort-ip-candidates';
    const publicId  = `ip_${ipId}`;
    const signature = cloudinary.utils.api_sign_request(
      {
        timestamp,
        public_id:      publicId,
        asset_folder:   folder,
        overwrite:      true,
        transformation: 'c_fill,w_300,h_300,g_face',
      },
      process.env.CLOUDINARY_API_SECRET
    );
    res.json({
      timestamp, signature, publicId,
      assetFolder: folder,
      cloudName: process.env.CLOUDINARY_CLOUD_NAME,
      apiKey:    process.env.CLOUDINARY_API_KEY,
    });
  } catch (err) {
    console.error('IP SIGNATURE ERROR:', err);
    res.status(500).json({ message: 'Signature generation failed' });
  }
};

// ═════════════════════════════════════════════════════════════
// Sort_IPS documents (PDF): Check list items, Crio embrio results…
// Stored in section "docs" — see services/ipDocs.js
// ═════════════════════════════════════════════════════════════
const parseIpDoc = (src) => {
  const ipId = Number(src.ipId);
  const docKey = String(src.docKey || '');
  return Number.isInteger(ipId) && ipId > 0 && DOC_KEY_REGEX.test(docKey) ? { ipId, docKey } : null;
};

// GET /api/upload/ip-doc-signature?ipId&docKey
export const getIpDocSignature = async (req, res) => {
  if (!req.session?.user) return res.status(401).json({ message: 'Not authenticated' });
  const q = parseIpDoc(req.query);
  if (!q) return res.status(400).json({ message: 'ipId y docKey son obligatorios' });
  try {
    if (!(await ipExists(q.ipId))) return res.status(404).json({ message: 'Registro IP no encontrado' });
    const timestamp = Math.round(Date.now() / 1000);
    const folder    = ipDocFolder(q.ipId);
    const publicId  = ipDocPublicId(q.ipId, q.docKey);
    const signature = cloudinary.utils.api_sign_request(
      { timestamp, public_id: publicId, asset_folder: folder, overwrite: true },
      process.env.CLOUDINARY_API_SECRET
    );
    res.json({
      timestamp, signature, publicId,
      assetFolder: folder,
      cloudName: process.env.CLOUDINARY_CLOUD_NAME,
      apiKey:    process.env.CLOUDINARY_API_KEY,
    });
  } catch (err) {
    console.error('IP DOC SIGNATURE ERROR:', err);
    res.status(500).json({ message: 'Signature generation failed' });
  }
};

// PUT /api/upload/ip-doc  { ipId, docKey, url } — saves the uploaded file
export const saveIpDoc = async (req, res) => {
  if (!req.session?.user) return res.status(401).json({ message: 'Not authenticated' });
  const q = parseIpDoc(req.body || {});
  const url = String(req.body?.url || '');
  if (!q) return res.status(400).json({ message: 'ipId y docKey son obligatorios' });
  if (!url.startsWith(`https://res.cloudinary.com/${process.env.CLOUDINARY_CLOUD_NAME}/`)) {
    return res.status(400).json({ message: 'URL de documento inválida' });
  }
  try {
    if (!(await ipExists(q.ipId))) return res.status(404).json({ message: 'Registro IP no encontrado' });
    const docs = await writeDoc(q.ipId, q.docKey, { url, uploaded_at: new Date().toISOString() }, req.session.user.id);
    await logUpdate(req.session.user.id, 'babysite', `Subió documento "${q.docKey}" de Sort_IPS #${q.ipId}`, new Date(), `${q.ipId}`);
    res.json({ success: true, docs });
  } catch (err) {
    console.error('SAVE IP DOC ERROR:', err);
    res.status(500).json({ message: 'Error al guardar el documento' });
  }
};

// GET /api/upload/ip-doc-stream?ipId&docKey — opens the PDF
export const streamIpDoc = async (req, res) => {
  if (!req.session?.user) return res.status(401).json({ message: 'Not authenticated' });
  const q = parseIpDoc(req.query);
  if (!q) return res.status(400).json({ message: 'ipId y docKey son obligatorios' });
  try {
    const doc = (await readDocs(q.ipId))[q.docKey];
    if (!doc?.url) return res.status(404).json({ message: 'Este documento no se ha subido' });
    await pipeStoredPdf(res, doc.url, ipDocPublicId(q.ipId, q.docKey));
  } catch (err) {
    console.error('STREAM IP DOC ERROR:', err);
    if (!res.headersSent) res.status(500).json({ message: 'Error al abrir el documento' });
  }
};

// DELETE /api/upload/ip-doc?ipId&docKey
export const deleteIpDoc = async (req, res) => {
  if (!req.session?.user) return res.status(401).json({ message: 'Not authenticated' });
  const q = parseIpDoc(req.query);
  if (!q) return res.status(400).json({ message: 'ipId y docKey son obligatorios' });
  try {
    const doc = (await readDocs(q.ipId))[q.docKey];
    if (doc?.url) await destroyIpDoc(q.ipId, q.docKey, doc.url);
    const docs = await writeDoc(q.ipId, q.docKey, null, req.session.user.id);
    await logDelete(req.session.user.id, 'babysite', `Eliminó documento "${q.docKey}" de Sort_IPS #${q.ipId}`, new Date(), `${q.ipId}`);
    res.json({ success: true, docs });
  } catch (err) {
    console.error('DELETE IP DOC ERROR:', err);
    res.status(500).json({ message: 'Error al eliminar el documento' });
  }
};