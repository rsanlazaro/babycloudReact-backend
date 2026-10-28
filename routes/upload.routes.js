import express from 'express';
import {
  getUploadSignature,
  getCandidateUploadSignature,
  getIpUploadSignature,
  getCandidateDocUploadSignature,
  streamCandidateDoc,
  deleteCandidateDoc,
  getSeguroPagoSignature,
  saveSeguroPagoDoc,
  streamSeguroPagoDoc,
  deleteSeguroPagoDoc,
  getIpDocSignature,
  saveIpDoc,
  streamIpDoc,
  deleteIpDoc,
} from '../controllers/upload.controller.js';
import authMiddleware from '../middleware/auth.js';

const router = express.Router();

router.get('/cloudinary-signature',           authMiddleware, getUploadSignature);
router.get('/candidate-cloudinary-signature', authMiddleware, getCandidateUploadSignature);
router.get('/ip-cloudinary-signature',        authMiddleware, getIpUploadSignature);   // Sort_IPS photo
router.get('/candidate-doc-signature',        authMiddleware, getCandidateDocUploadSignature);
router.get('/candidate-doc-stream',           authMiddleware, streamCandidateDoc);
router.delete('/candidate-doc',              authMiddleware, deleteCandidateDoc);

// Comprobante (PDF) of each registered payment — Seguro de Gastos Médicos Mayores
router.get('/seguro-pago-signature',          authMiddleware, getSeguroPagoSignature);
router.put('/seguro-pago-doc',                authMiddleware, saveSeguroPagoDoc);
router.get('/seguro-pago-stream',             authMiddleware, streamSeguroPagoDoc);
router.delete('/seguro-pago-doc',             authMiddleware, deleteSeguroPagoDoc);

// Sort_IPS documents (PDF) — Check list, Crio embrio results
router.get('/ip-doc-signature',               authMiddleware, getIpDocSignature);
router.put('/ip-doc',                         authMiddleware, saveIpDoc);
router.get('/ip-doc-stream',                  authMiddleware, streamIpDoc);
router.delete('/ip-doc',                      authMiddleware, deleteIpDoc);

export default router;