import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import pino from 'pino';
import { pinoHttp } from 'pino-http';
import apiRoutes from './routes/api.js'; // .js extension required

const logger = pino({
  level: 'info',
  transport: {
    target: 'pino-pretty',
    options: { colorize: true }
  }
});

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// 4. NEW: Asynchronous High-Performance Logging
// This replaces the old manual "app.use((req, res)...)" middleware.
app.use(pinoHttp({ 
  logger: logger,
  // Use 'autoLogging: false' if you want to rely only on explicit logs, 
  // but usually true (default) is best for tracking response times.
  autoLogging: true,
  
  // Custom Serializers to Redact Sensitive Data
  serializers: {
    req: (req: any) => ({
      id: req.id,
      method: req.method,
      url: req.url,
      query: req.query,
      params: req.params,
      // Redact sensitive headers
      headers: {
        ...req.headers,
        authorization: '[REDACTED]',
        cookie: '[REDACTED]'
      },
      remoteAddress: req.remoteAddress
    })
  }
}));

app.use('/api/v1', apiRoutes);

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  logger.info(`Server running on http://localhost:${PORT}`);
});