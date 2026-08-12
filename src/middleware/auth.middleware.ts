import { Request, Response, NextFunction } from 'express';
import { createClient } from '@supabase/supabase-js';

// Initialize Supabase Client
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// Extend Express Request interface to include user
export interface AuthRequest extends Request {
  user?: {
    id: string; 
    supabaseUid: string;
    email: string;
  };
}

export const requireAuth = async (req: AuthRequest, res: Response, next: NextFunction): Promise<void> => {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    res.status(401).json({ error: "Missing Authorization header" });
    return;
  }

  const token = authHeader.replace('Bearer ', '');

  try {
    // 1. Verify Token with Supabase
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) {
      res.status(401).json({ error: "Invalid or expired token" });
      return;
    }

    // 2. Attach User Info to Request
    req.user = {
      id: user.id,
      supabaseUid: user.id,
      email: user.email || ''
    };

    next();
  } catch (err) {
    res.status(500).json({ error: "Authentication service error" });
  }
};