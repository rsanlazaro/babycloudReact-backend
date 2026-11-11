// routes/invoiceHistory.routes.js
// Progestor → Admin → Bills: history of the generated invoices
import { Router } from 'express';
import { getInvoices, saveInvoice, deleteInvoice } from '../controllers/invoiceHistory.controller.js';

const router = Router();

router.get('/',       getInvoices);   // ?empresa=babymedic|nexatravel|travelmedicalcare&search=
router.post('/',      saveInvoice);   // register / update when a PDF is generated
router.delete('/:id', deleteInvoice);

export default router;