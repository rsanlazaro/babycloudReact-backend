import pool from '../db.js';

export const getMe = (req, res) => {
  if (!req.session?.user) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  res.json({
    id: req.session.user.id,
    username: req.session.user.username,
    profileImage: req.session.user.profileImage || null,
  });
};

export const updateProfileImage = async (req, res) => {
  if (!req.session?.user) {
    return res.status(401).json({ message: 'Unauthorized' });
  }

  const userId = req.session.user.id;
  const { profileUrl, publicId, version } = req.body;

  if (!profileUrl || !publicId || !version) {
    return res.status(400).json({ message: 'Missing required fields' });
  }

  try {
    // ✅ Update DB
    await pool.query(
      'UPDATE users SET profile_url = ? WHERE id = ?',
      [profileUrl, userId]
    );

    // ✅ Update session
    const cloudName = process.env.CLOUDINARY_CLOUD_NAME;
    const url = `https://res.cloudinary.com/${cloudName}/image/upload/v${version}/${publicId}.jpg`;

    req.session.user.profileImage = { publicId, version, url };

    // ✅ Persist session (important for Redis)
    req.session.save(() => {
      res.json({ success: true });
    });
  } catch (err) {
    console.error('PROFILE IMAGE UPDATE ERROR:', err);
    res.status(500).json({ message: 'Failed to update profile image' });
  }
};
