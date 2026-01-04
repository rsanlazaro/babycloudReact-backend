import express from 'express';
import {
  getMe,
  updateProfileImage,
  updateProfile,
  getAllUsers,
  createUser,
  updateUser,
  deleteUser,
  bulkDeleteUsers,
} from '../controllers/user.controller.js';

const router = express.Router();

// Profile routes
router.get('/me', getMe);
router.put('/profile-image', updateProfileImage);
router.put('/profile', updateProfile);

// User management routes
router.get('/', getAllUsers);
router.post('/', createUser);
router.put('/:id', updateUser);
router.delete('/:id', deleteUser);
router.post('/bulk-delete', bulkDeleteUsers);

export default router;
