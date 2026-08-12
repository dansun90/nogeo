import { Router } from 'express';
import { handleQuery } from '../controllers/query.controller.js';
import { signup, login, getMe } from '../controllers/auth.controller.js';
import { getHistory, getHistoryDetail } from '../controllers/history.controller.js';
import { requireAuth } from '../middleware/auth.middleware.js';

const router = Router();

// PUBLIC ROUTES
router.post('/auth/signup', signup);
router.post('/auth/login', login);

// PROTECTED ROUTES (Require Login)
router.use(requireAuth); // All routes below this line require a valid token

router.get('/user/me', getMe);
router.post('/query', handleQuery); // Now protected
router.get('/history', getHistory);
router.get('/history/:id', getHistoryDetail);

export default router;