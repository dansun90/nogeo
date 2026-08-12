import { Request, Response } from 'express';
import { createClient } from '@supabase/supabase-js';
// FIX: Import the shared instance
import { prisma } from '../lib/prisma.js';

const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// DELETE: const prisma = new PrismaClient(); <-- Deleted

export const signup = async (req: Request, res: Response): Promise<void> => {
  const { email, password } = req.body;

  try {
    // 1. Create User in Supabase Auth
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
    });

    if (error) throw error;
    if (!data.user) throw new Error("No user created");

    // 2. Create User in Our Database (Sync)
    const existingUser = await prisma.user.findUnique({ where: { email }});
    
    if (!existingUser) {
        await prisma.user.create({
        data: {
            email: data.user.email!,
            supabaseUid: data.user.id
        }
        });
    }

    res.status(201).json({ userId: data.user.id, session: data.session });
  } catch (error: any) {
    res.status(400).json({ error: error.message });
  }
};

export const login = async (req: Request, res: Response): Promise<void> => {
  const { email, password } = req.body;

  try {
    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password,
    });

    if (error) throw error;

    res.json({ userId: data.user?.id, token: data.session?.access_token });
  } catch (error: any) {
    res.status(401).json({ error: error.message });
  }
};

export const getMe = async (req: Request, res: Response): Promise<void> => {
    try {
        const userUid = (req as any).user.supabaseUid;
        
        // Fetch fresh data from DB (to get credit balance)
        const dbUser = await prisma.user.findUnique({
            where: { supabaseUid: userUid }
        });

        if (!dbUser) {
            res.status(404).json({ error: "User not found" });
            return;
        }

        // Return strictly formatted according to API V3.1.md
        res.json({
            userId: dbUser.supabaseUid,
            email: dbUser.email,
            subscription: {
                status: dbUser.subscriptionStatus,
                monthlyCreditsRemaining: dbUser.monthlyCreditsRemaining
            },
            purchasedCreditsRemaining: dbUser.purchasedCreditsRemaining
        });
    } catch (error) {
        res.status(500).json({ error: "Failed to fetch user profile" });
    }
}