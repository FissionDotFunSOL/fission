import { Router } from 'express';
import * as ctrl from './controllers.js';

const router = Router();

// Health
router.get('/health', ctrl.healthCheck);

// Tokens
router.get('/tokens',             ctrl.listTokens);
router.get('/tokens/:address',    ctrl.getToken);
router.post('/tokens/register',   ctrl.registerToken);
router.post('/tokens/:address/refresh-metadata', ctrl.refreshTokenMetadata);

// Positions
router.get('/positions',          ctrl.listPositions);
router.get('/positions/live',     ctrl.getLivePositions);
router.get('/positions/:address', ctrl.getPosition);

// Buybacks
router.get('/buybacks',           ctrl.listBuybacks);
router.get('/buybacks/:address',  ctrl.getBuybacksByToken);

// Runs
router.get('/runs',               ctrl.listRuns);

// Stats
router.get('/stats',              ctrl.getStats);

// Trade History
router.get('/trades',             ctrl.getTradeHistory);

// Markets (available Ostium stock perp markets)
router.get('/markets',            ctrl.listMarkets);

// Perp venues — which one the engine is trading on + each one's state
router.get('/venues',             ctrl.listVenues);
router.get('/recovery',           ctrl.getRecovery);
router.post('/recovery/claim',    ctrl.claimRecovery);

// Launchpads (supported Robinhood Chain launchpads)
router.get('/launchpads',         ctrl.listLaunchpads);

// Strategies (trading modes a token can pick)
router.get('/strategies',         ctrl.listStrategies);

// Stock ticker (Yahoo Finance proxy for the frontend ticker bar)
router.get('/ticker',             ctrl.getTicker);

// Charts — stock candles + Pons token candles/market data
router.get('/chart/stock/:symbol',   ctrl.getStockChart);
router.get('/chart/token/:address',  ctrl.getTokenChart);
router.get('/tokens/:address/marketdata', ctrl.getTokenMarketData);

// On-chain stocks — tokenized equities (xStocks) priced via Birdeye
router.get('/onchain-stocks',     ctrl.getOnchainStocks);

// System Status (full engine state)
router.get('/status',             ctrl.getSystemStatus);

// Admin: manually trigger a worker cycle (for testing)
router.post('/admin/trigger/:worker', ctrl.triggerWorker);
router.get('/admin/tokens/pending',          ctrl.listPendingTokens);
router.post('/admin/tokens/:address/:action', ctrl.moderateToken);

export default router;
