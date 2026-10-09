import { Router } from 'express';
import { authController } from '../controllers/authController';
import { authMiddleware } from '../middlewares/authMiddleware';
import {
  validateBody,
  registerSchema,
  loginSchema,
} from '../middlewares/validateMiddleware';

export const authRoutes = Router();

// POST /auth/register
authRoutes.post(
  '/register',
  validateBody(registerSchema),
  authController.register.bind(authController)
);

// POST /auth/login
authRoutes.post(
  '/login',
  validateBody(loginSchema),
  authController.login.bind(authController)
);

// GET /auth/me
authRoutes.get(
  '/me',
  authMiddleware,
  authController.getMe.bind(authController)
);
