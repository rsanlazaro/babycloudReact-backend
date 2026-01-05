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
  getUserRoles,
  updateUserRoles,
  getAccessRoles,
  updateAccessRoles,
} from '../controllers/user.controller.js';

const router = express.Router();

// Profile routes
router.get('/me', getMe);
router.put('/profile-image', updateProfileImage);
router.put('/profile', updateProfile);

// User access roles routes
router.get('/access', getAccessRoles);
router.put('/access', updateAccessRoles);

// User management routes
router.get('/', getAllUsers);
router.post('/', createUser);
router.post('/bulk-delete', bulkDeleteUsers);
router.put('/:id', updateUser);
router.delete('/:id', deleteUser);

// User roles routes
router.get('/:id/roles', getUserRoles);
router.put('/:id/roles', updateUserRoles);

export default router;
