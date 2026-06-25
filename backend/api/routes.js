import { Router } from 'express';
import * as ctrl from './controllers.js';

const router = Router();

// Health
router.get('/health', ctrl.healthCheck);

// Tokens
router.get('/tokens',          ctrl.listTokens);
router.get('/tokens/:mint',    ctrl.getToken);
router.post('/tokens/register', ctrl.registerToken);

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

// System Status (full engine state)
router.get('/status',          ctrl.getSystemStatus);

export default router;
