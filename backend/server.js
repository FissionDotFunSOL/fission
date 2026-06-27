import express from 'express';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import config from './config.js';
import logger from './utils/logger.js';
import routes from './api/routes.js';
import { startScheduler, stopScheduler } from './workers/scheduler.js';
import { shutdown as shutdownPerps } from './services/perps-router.js';

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();

// Middleware
app.use(cors({
  origin: [
    'https://fission.fun',
    'https://www.fission.fun',
    /\.vercel\.app$/,       // preview deploys
    'http://localhost:5173', // local dev
    'http://localhost:3000',
  ],
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type'],
}));
app.use(express.json());

// Trust proxy (Railway / Vercel sit behind load balancers)
app.set('trust proxy', 1);

// Rate limiting
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 500,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, try again later' },
  validate: { trustProxy: false, xForwardedForHeader: false },
});

const registerLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many registration attempts, try again later' },
  validate: { trustProxy: false, xForwardedForHeader: false },
});

// Request logging
app.use((req, _res, next) => {
  logger.debug(`${req.method} ${req.path}`, {
    query: req.query,
    ip: req.ip,
  });
  next();
});

// Mount API routes with rate limiting
app.use('/api/v1/tokens/register', registerLimiter);
app.use('/api/v1', apiLimiter, routes);

// 404 catch-all
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Global error handler
app.use((err, _req, res, _next) => {
  logger.error('Unhandled express error', { error: err.message, stack: err.stack });
  res.status(500).json({ error: 'Internal server error' });
});

// ---------------------------------------------------------------------------
// Start server + workers
// ---------------------------------------------------------------------------
const server = app.listen(config.PORT, () => {
  logger.info(`Fission backend listening on port ${config.PORT}`, {
    env: config.NODE_ENV,
    port: config.PORT,
  });

  // ── Startup diagnostics ──
  const diag = {
    keypair: config.protocolKeypair ? 'LOADED' : 'MISSING — workers cannot sign transactions',
    publicKey: config.PROTOCOL_PUBKEY?.toBase58() || 'MISSING',
    rpc: config.SOLANA_RPC_URL.includes('mainnet-beta.solana.com') ? 'PUBLIC (rate-limited)' : 'CUSTOM',
    rpcUrl: config.SOLANA_RPC_URL,
    firebase: config.FIREBASE_SERVICE_ACCOUNT ? 'CONFIGURED' : 'MOCK MODE (in-memory)',
    jupiterPerps: config.JUPITER_PERPS_PROGRAM_ID,
    jupiterSwap: config.JUPITER_API_URL,
    markets: config.PERPS_MARKETS.join(', '),
  };

  logger.info('Startup diagnostics', diag);

  if (!config.protocolKeypair) {
    logger.warn('=== PROTOCOL_KEYPAIR not set ===');
    logger.warn('Workers will start but ALL on-chain operations will fail.');
    logger.warn('Set PROTOCOL_KEYPAIR in backend/.env to enable transaction signing.');
  }

  if (!config.FIREBASE_SERVICE_ACCOUNT) {
    logger.warn('=== FIREBASE not configured ===');
    logger.warn('Running in mock mode — data will be lost on restart.');
  }

  if (config.SOLANA_RPC_URL.includes('mainnet-beta.solana.com')) {
    logger.warn('=== Using public RPC ===');
    logger.warn('This will be rate-limited. Use Helius, QuickNode, or Triton for production.');
  }

  // Start background workers
  startScheduler();
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
async function gracefulShutdown(signal) {
  logger.info(`${signal} received — shutting down gracefully`);

  // Stop accepting new connections
  server.close(() => {
    logger.info('HTTP server closed');
  });

  // Stop workers
  stopScheduler();

  // Disconnect services
  try {
    await shutdownPerps();
  } catch (err) {
    logger.warn('Jupiter Perps shutdown error during graceful exit', { error: err.message });
  }

  // Allow a brief window for in-flight ops
  setTimeout(() => {
    logger.info('Exiting process');
    process.exit(0);
  }, 3000);
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

// Catch unhandled errors
process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection', { reason: reason?.message || reason });
});

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception', { error: err.message, stack: err.stack });
  process.exit(1);
});

export default app;
