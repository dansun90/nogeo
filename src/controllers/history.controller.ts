import { Response } from 'express';
import { AuthRequest } from '../middleware/auth.middleware.js'; 
import { prisma } from '../lib/prisma.js'; 
import { createClient } from '@supabase/supabase-js';

// Initialize Supabase to fetch files
const supabase = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

// GET /history
export const getHistory = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const userId = req.user!.supabaseUid;

    const reports = await prisma.searchReport.findMany({
      where: { user: { supabaseUid: userId } },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        originalQuery: true,
        finalAnswer: true,
        createdAt: true
      }
    });

    const historyList = reports.map(r => ({
      reportId: r.id,
      query: r.originalQuery,
      summary: r.finalAnswer.substring(0, 100) + "...",
      createdAt: r.createdAt
    }));

    res.json(historyList);
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch history" });
  }
};

// GET /history/:id
export const getHistoryDetail = async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const { id } = req.params;
    const userId = req.user!.supabaseUid;

    // 1. Fetch the "Receipt" from the Database
    const report = await prisma.searchReport.findFirst({
      where: { 
        id: id,
        user: { supabaseUid: userId } 
      }
    });

    if (!report) {
      res.status(404).json({ error: "Report not found" });
      return;
    }

    // 2. Check if the data is "Offloaded" to Storage
    // We cast to 'any' to easily access the JSON properties
    const reportData = report.fullReportJson as any;

    if (reportData.offloaded && reportData.storage_path) {
        // 3. It is offloaded! Go fetch the file from Supabase Storage
        const { data, error } = await supabase.storage
            .from(reportData.storage_bucket)
            .download(reportData.storage_path);

        if (error || !data) {
            console.error("Storage Fetch Error:", error);
            res.status(500).json({ error: "Failed to retrieve report content" });
            return;
        }

        // 4. Convert the File (Blob) back into JSON
        const text = await data.text();
        const fullJson = JSON.parse(text);
        
        res.json(fullJson);
    } else {
        // 5. It was NOT offloaded (legacy data), just return it directly
        res.json(reportData);
    }

  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Failed to fetch report detail" });
  }
};