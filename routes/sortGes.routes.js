// routes/sortGes.routes.js
import { Router } from 'express';
import {
  getAllCandidates, getCandidate, createCandidate, updateCandidate, deleteCandidate,
  getAltaGesca, upsertAltaGesca,
  getChecklist, upsertChecklist,
  getSeguroVidaList, createSeguroVida, updateSeguroVida, deleteSeguroVida,
  upsertSeguroVidaPago, deleteSeguroVidaPago,
  getSeguroMatList, createSeguroMat, updateSeguroMat, deleteSeguroMat,
  updateCuotaPago, removeCuotaPago,
  getPsicoInicial, updatePsicoInicialRow,
  getSeguimientoList, createSeguimiento, updateSeguimiento, deleteSeguimiento,
} from '../controllers/sortGes.controller.js';

const router = Router();

// ── Candidates ───────────────────────────────────────────────
router.get('/',       getAllCandidates);
router.post('/',      createCandidate);
router.get('/:id',    getCandidate);
router.put('/:id',    updateCandidate);
router.delete('/:id', deleteCandidate);

// ── Tab 1: Alta GESCA ────────────────────────────────────────
router.get('/:candidateId/alta-gesca', getAltaGesca);
router.put('/:candidateId/alta-gesca', upsertAltaGesca);

// ── Tab 2: Checklist ─────────────────────────────────────────
router.get('/:candidateId/checklist', getChecklist);
router.put('/:candidateId/checklist', upsertChecklist);

// ── Tab 3: Seguro de Vida ────────────────────────────────────
router.get(    '/:candidateId/seguro-vida',              getSeguroVidaList);
router.post(   '/:candidateId/seguro-vida',              createSeguroVida);
router.put(    '/:candidateId/seguro-vida/:id',          updateSeguroVida);
router.delete( '/:candidateId/seguro-vida/:id',          deleteSeguroVida);
router.put(    '/:candidateId/seguro-vida/:id/pago',     upsertSeguroVidaPago);
router.delete( '/:candidateId/seguro-vida/:id/pago',     deleteSeguroVidaPago);

// ── Tab 3: Seguro de Maternidad ──────────────────────────────
router.get(    '/:candidateId/seguro-mat',               getSeguroMatList);
router.post(   '/:candidateId/seguro-mat',               createSeguroMat);
router.put(    '/:candidateId/seguro-mat/:id',           updateSeguroMat);
router.delete( '/:candidateId/seguro-mat/:id',           deleteSeguroMat);
router.put(    '/:candidateId/seguro-mat/:polizaId/cuotas/:cuotaNum',       updateCuotaPago);
router.delete( '/:candidateId/seguro-mat/:polizaId/cuotas/:cuotaNum/pago',  removeCuotaPago);

// ── Tab 4: Psico Social ──────────────────────────────────────
router.get('/:candidateId/psico-inicial',              getPsicoInicial);
router.put('/:candidateId/psico-inicial/:etapaOrden',  updatePsicoInicialRow);
router.get(    '/:candidateId/seguimiento',            getSeguimientoList);
router.post(   '/:candidateId/seguimiento',            createSeguimiento);
router.put(    '/:candidateId/seguimiento/:id',        updateSeguimiento);
router.delete( '/:candidateId/seguimiento/:id',        deleteSeguimiento);

export default router;