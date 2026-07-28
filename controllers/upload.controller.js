import cloudinary from '../config/cloudinary.js';
import { logActivity, logUpdate, logCreate, logDelete, logLogin, logLogout, ACTIVITY_TYPES, ENTITY_TYPES } from '../services/activityLogger.js';

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