import express from 'express';

const router = express.Router();

router.get('/me', (req, res) => {

  if (!req.session.user) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  res.json({
    id: req.session.user.id,
    username: req.session.user.username,
    profileImage: req.session.user.profileImage || null,
  });
});

router.put('/profile-image', (req, res) => {

  if (!req.session.user) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  const { publicId, version } = req.body;

  const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
  const url = `https://res.cloudinary.com/${cloudName}/image/upload/v${version}/${publicId}.jpg`;

  req.session.profileImage = { publicId, version, url };
  req.session.user.profileImage = req.session.profileImage;

  res.json({ success: true });
});

export default router;
