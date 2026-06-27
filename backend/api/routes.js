import { Router } from 'express';
import * as ctrl from './controllers.js';

const router = Router();

// Health
router.get('/health', ctrl.healthCheck);

// Tokens
router.get('/tokens',          ctrl.listTokens);
router.get('/tokens/:mint',    ctrl.getToken);
router.post('/tokens/register', ctrl.registerToken);
router.post('/tokens/:mint/refresh-metadata', ctrl.refreshTokenMetadata);

// Positions
router.get('/positions',       ctrl.listPositions);
router.get('/positions/:mint', ctrl.getPosition);

// Buybacks
router.get('/buybacks',        ctrl.listBuybacks);
router.get('/buybacks/:mint',  ctrl.getBuybacksByMint);

// Runs
router.get('/runs',            ctrl.listRuns);

// Stats
router.get('/stats',           ctrl.getStats);

// Trade History
router.get('/trades',          ctrl.getTradeHistory);

// Markets (available Jupiter Perps markets)
router.get('/markets',         ctrl.listMarkets);

// System Status (full engine state)
router.get('/status',          ctrl.getSystemStatus);

// Admin: manually trigger a worker cycle (for testing)
router.post('/admin/trigger/:worker', ctrl.triggerWorker);

export default router;
