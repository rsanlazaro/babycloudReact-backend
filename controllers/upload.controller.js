import cloudinary from '../config/cloudinary.js';
import { logActivity, logUpdate, logCreate, logDelete, logLogin, logLogout, ACTIVITY_TYPES, ENTITY_TYPES } from '../services/activityLogger.js';

export const getUploadSignature = async (req, res) => {
  try {
    if (!req.session || !req.session.user) {
      return res.status(401).json({ message: 'Not authenticated' });
    }

    const userId = req.session.user.id;
    const timestamp = Math.round(Date.now() / 1000);

    // Get folder from query params
    const folder = req.query.folder || 'default-folder';

    // Just use the user ID, not the full path
    const publicId = `user_${userId}`;

    const signature = cloudinary.utils.api_sign_request(
      {
        timestamp,
        public_id: publicId,
        asset_folder: folder,  // ← Add this parameter
        overwrite: true,
        transformation: 'c_fill,w_300,h_300,g_face',
      },
      process.env.CLOUDINARY_API_SECRET
    );

    res.json({
      timestamp,
      signature,
      publicId,
      assetFolder: folder,  // ← Send this to frontend
      cloudName: process.env.CLOUDINARY_CLOUD_NAME,
      apiKey: process.env.CLOUDINARY_API_KEY,
    });

  } catch (err) {
    console.error('SIGNATURE ERROR STACK:', err);
    res.status(500).json({ message: 'Signature generation failed' });
  }
};

export const getCandidateUploadSignature = async (req, res) => {
  try {
    if (!req.session?.user) return res.status(401).json({ message: 'Not authenticated' });

    const { candidateId } = req.query;
    if (!candidateId) return res.status(400).json({ message: 'candidateId required' });

    const timestamp = Math.round(Date.now() / 1000);
    const folder = 'sort-ges-candidates';
    const publicId = `candidate_${candidateId}`;

    const signature = cloudinary.utils.api_sign_request(
      {
        timestamp, public_id: publicId, asset_folder: folder,
        overwrite: true, transformation: 'c_fill,w_300,h_300,g_face'
      },
      process.env.CLOUDINARY_API_SECRET
    );

    res.json({
      timestamp, signature, publicId,
      assetFolder: folder, cloudName: process.env.CLOUDINARY_CLOUD_NAME,
      apiKey: process.env.CLOUDINARY_API_KEY
    });
  } catch (err) {
    console.error('CANDIDATE SIGNATURE ERROR:', err);
    res.status(500).json({ message: 'Signature generation failed' });
  }
};
