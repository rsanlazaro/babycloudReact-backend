import express from 'express';
import {
  getMe,
  updateProfileImage,
} from '../controllers/user.controller.js';

const router = express.Router();

router.get('/me', getMe);
router.put('/profile-image', updateProfileImage);

export default router;
