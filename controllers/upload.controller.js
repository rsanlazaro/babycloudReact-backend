import cloudinary from '../config/cloudinary.js';

export const getUploadSignature = (req, res) => {

  try {
    if (!req.session || !req.session.user) {
      return res.status(401).json({ message: 'Not authenticated' });
    }

    const userId = req.session.user.id;
    const timestamp = Math.round(Date.now() / 1000);

    const publicId = `user_${userId}`;

    const signature = cloudinary.utils.api_sign_request(
      {
        timestamp,
        public_id: publicId,
        overwrite: true,
        transformation: 'c_fill,w_300,h_300,g_face',
      },
      process.env.CLOUDINARY_API_SECRET
    );

    res.json({
      timestamp,
      signature,
      publicId,
      cloudName: process.env.CLOUDINARY_CLOUD_NAME,
      apiKey: process.env.CLOUDINARY_API_KEY,
    });
  } catch (err) {
    console.error('SIGNATURE ERROR STACK:', err);
    res.status(500).json({ message: 'Signature generation failed' });
  }
};
