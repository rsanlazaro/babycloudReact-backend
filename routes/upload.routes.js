import express from 'express';
import cloudinary from 'cloudinary';

import { getUploadSignature } from '../controllers/upload.controller.js';
import authMiddleware from '../middleware/auth.js';

const router = express.Router();

// Cloudinary v2
const { v2: cloudinaryV2 } = cloudinary;

router.get('/cloudinary-signature', authMiddleware, getUploadSignature);

export default router;