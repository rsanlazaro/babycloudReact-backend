// backend/routes/sortIp.routes.js — mounted at /api/sort-ip
import { Router } from 'express';
import {
  getAllIps, getIp, getAvailableGuests, createIp, updateIp, saveSection, deleteIp, lookupPasaporte,
  updateIpFoto, updateGuestPassword, setCloudView, getCloudViews, createGuestAccount, linkGuestByPasaporte,
} from '../controllers/sortIp.controller.js';

const router = Router();

router.get('/',                      getAllIps);
router.post('/',                     createIp);
router.get('/guests-available',      getAvailableGuests); // must be before '/:id'
router.get('/pasaporte/:pasaporte',  lookupPasaporte);    // must be before '/:id'
router.get('/cloud-views',           getCloudViews);      // must be before '/:id' — Cloud IPS list: Vista on/off
router.get('/:id',                   getIp);
router.put('/:id',                   updateIp);
router.delete('/:id',                deleteIp);
router.put('/:id/sections/:section', saveSection);
router.put('/:id/foto',              updateIpFoto);       // profile photo
router.put('/:id/guest-password',    updateGuestPassword); // password of the linked Guests account
router.put('/:id/cloud-view',        setCloudView);        // Alta IP → Vista en Baby Cloud (on/off)
router.post('/:id/guest-account',    createGuestAccount);  // Alta IP → create the IP's Guests account
router.post('/:id/link-guest',       linkGuestByPasaporte); // Alta IP → link the account with the same passport

export default router;