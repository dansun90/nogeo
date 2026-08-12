import { Request, Response } from 'express';
import { RAGService } from '../services/rag.service.js';
import { AuthRequest } from '../middleware/auth.middleware.js'; // Import AuthRequest

// Instantiate Service (Preserving your "Fail Fast" preference)
const ragService = new RAGService();

export const handleQuery = async (req: AuthRequest, res: Response): Promise<void> => {
  // BEST PRACTICE: Use the logger injected by pino-http
  // This ensures logs include the unique "req.id" for debugging.
  // We cast to 'any' to avoid strict TypeScript setup for now.
  const log = (req as any).log || console;

  try {
    const { queryText } = req.body;

    // NEW: Get User ID from the Auth Middleware
    // If middleware worked, req.user is guaranteed to exist
    const userId = req.user!.supabaseUid;
    
    // Robust IP extraction
    const clientIp = (req.headers['x-forwarded-for'] as string || req.socket.remoteAddress || '').split(',')[0].trim();

    if (!queryText || typeof queryText !== 'string') {
      log.warn({ msg: 'Validation failed: Missing or invalid queryText', ip: clientIp });
      res.status(400).json({ error: "queryText must be a non-empty string" });
      return;
    }

    // Optional: Log that business logic is starting (helpful for timing)
    log.info({ msg: 'Starting RAG pipeline', queryLength: queryText.length, userId });

    // Pass extracted IP to pipeline
    const result = await ragService.runPipeline(queryText, clientIp, userId);

    res.json(result);

  } catch (error: any) {
    // BEST PRACTICE: Log the full error on the server...
    log.error({ msg: "Pipeline Fatal Error", error: error, stack: error.stack });
    
    // ...but only send a generic message to the user (Security: Don't leak stack traces)
    res.status(500).json({ error: error.message || "Internal Server Error" });
  }
};