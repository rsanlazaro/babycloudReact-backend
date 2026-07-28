import express from 'express';
import {
  getUploadSignature,
  getCandidateUploadSignature,
  getCandidateDocUploadSignature,
  streamCandidateDoc,
  deleteCandidateDoc,
} from '../controllers/upload.controller.js';
import authMiddleware from '../middleware/auth.js';

const router = express.Router();

router.get('/cloudinary-signature',           authMiddleware, getUploadSignature);
router.get('/candidate-cloudinary-signature', authMiddleware, getCandidateUploadSignature);
router.get('/candidate-doc-signature',        authMiddleware, getCandidateDocUploadSignature);
router.get('/candidate-doc-stream',           authMiddleware, streamCandidateDoc);
router.delete('/candidate-doc',              authMiddleware, deleteCandidateDoc);

export default router;