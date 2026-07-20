import admin from 'firebase-admin';
import { isAddress } from 'ethers';
import logger from '../utils/logger.js';
import config from '../config.js';

// ---------------------------------------------------------------------------
// Firebase initialisation
// ---------------------------------------------------------------------------
let db = null;
let _mockMode = false;

try {
  if (config.FIREBASE_SERVICE_ACCOUNT) {
    const serviceAccount =
      typeof config.FIREBASE_SERVICE_ACCOUNT === 'string'
        ? JSON.parse(config.FIREBASE_SERVICE_ACCOUNT)
        : config.FIREBASE_SERVICE_ACCOUNT;

    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
    db = admin.firestore();
    logger.info('Firebase initialised with service account');
  } else {
    logger.warn(
      'FIREBASE_SERVICE_ACCOUNT not set — running in MOCK mode (in-memory store)',
    );
    _mockMode = true;
  }
} catch (err) {
  logger.error('Firebase init failed — falling back to mock mode', {
    error: err.message,
  });
  _mockMode = true;
}

// ---------------------------------------------------------------------------
// In-memory mock store (used when Firebase is not configured)
// ---------------------------------------------------------------------------
const _mem = {
  tokens: new Map(),
  positions: new Map(),
  runs: new Map(),
  buybacks: new Map(),
  splits: new Map(),
  config: new Map(),
};

function _id() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// ---------------------------------------------------------------------------
// Generic Firestore helpers
// ---------------------------------------------------------------------------

/**
 * Add a document to a collection. Returns the generated document ID.
 */
export async function addDoc(collection, data) {
  if (_mockMode) {
    const id = _id();
    _mem[collection]?.set(id, { id, ...data });
    return id;
  }
  const ref = await db.collection(collection).add(data);
  return ref.id;
}

/**
 * Set (upsert) a document by ID.
 */
export async function setDoc(collection, id, data, merge = true) {
  if (_mockMode) {
    const existing = _mem[collection]?.get(id) || {};
    _mem[collection]?.set(id, merge ? { ...existing, id, ...data } : { id, ...data });
    return;
  }
  await db.collection(collection).doc(id).set(data, { merge });
}

/**
 * Get a single document by ID.
 */
export async function getDoc(collection, id) {
  if (_mockMode) {
    return _mem[collection]?.get(id) || null;
  }
  const snap = await db.collection(collection).doc(id).get();
  return snap.exists ? { id: snap.id, ...snap.data() } : null;
}

/**
 * Query documents. Filters is an array of [field, op, value].
 */
export async function queryDocs(collection, filters = [], orderByField = null, limitN = 100) {
  if (_mockMode) {
    let items = Array.from(_mem[collection]?.values() || []);
    for (const [field, op, value] of filters) {
      items = items.filter((doc) => {
        switch (op) {
          case '==': return doc[field] === value;
          case '!=': return doc[field] !== value;
          case '>':  return doc[field] > value;
          case '>=': return doc[field] >= value;
          case '<':  return doc[field] < value;
          case '<=': return doc[field] <= value;
          default:   return true;
        }
      });
    }
    if (orderByField) {
      items.sort((a, b) => (b[orderByField] ?? 0) - (a[orderByField] ?? 0));
    }
    return items.slice(0, limitN);
  }

  let ref = db.collection(collection);
  for (const [field, op, value] of filters) {
    ref = ref.where(field, op, value);
  }
  if (orderByField) {
    ref = ref.orderBy(orderByField, 'desc');
  }
  ref = ref.limit(limitN);
  const snap = await ref.get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/**
 * Get all documents in a collection (with optional limit).
 */
export async function getAllDocs(collection, limitN = 200) {
  return queryDocs(collection, [], null, limitN);
}

/**
 * Update specific fields on a document.
 */
export async function updateDoc(collection, id, data) {
  if (_mockMode) {
    const existing = _mem[collection]?.get(id);
    if (existing) {
      _mem[collection]?.set(id, { ...existing, ...data });
    }
    return;
  }
  await db.collection(collection).doc(id).update(data);
}

/**
 * Delete a document.
 */
export async function deleteDoc(collection, id) {
  if (_mockMode) {
    _mem[collection]?.delete(id);
    return;
  }
  await db.collection(collection).doc(id).delete();
}

// ---------------------------------------------------------------------------
// Collection-specific convenience helpers
// ---------------------------------------------------------------------------

// In-memory cache to prevent Firestore quota exhaustion
const _cache = {
  tokens: { data: null, expiresAt: 0 },
  positions: { data: null, expiresAt: 0 },
};
const CACHE_TTL_MS = 30_000; // 30 seconds

function getCached(key) {
  const entry = _cache[key];
  if (entry && entry.data && Date.now() < entry.expiresAt) return entry.data;
  return null;
}

function setCache(key, data) {
  _cache[key] = { data, expiresAt: Date.now() + CACHE_TTL_MS };
}

function invalidateCache(key) {
  if (_cache[key]) _cache[key].expiresAt = 0;
}

// --- tokens ---
export async function addToken(data) {
  invalidateCache('tokens');
  return addDoc('tokens', { ...data, address: data.address || null, createdAt: Date.now(), status: 'active' });
}

export async function getToken(address) {
  // use token address as doc id
  return getDoc('tokens', address);
}

export async function setToken(address, data) {
  invalidateCache('tokens');
  return setDoc('tokens', address, data);
}

export async function getAllTokens() {
  const cached = getCached('tokens');
  if (cached) return cached;
  const all = await getAllDocs('tokens');
  // Ignore legacy / malformed docs whose id isn't a valid EVM address.
  // (An earlier Solana build left Pump.fun mint-keyed docs in this store;
  // an EVM engine must never try to trade or claim against those.)
  const result = all.filter(t => {
    const id = t.id || t.address;
    return id && isAddress(id);
  });
  if (all.length !== result.length) {
    logger.debug('Filtered non-EVM token docs', { total: all.length, valid: result.length });
  }
  setCache('tokens', result);
  return result;
}

// --- positions ---
export async function getPosition(mint) {
  return getDoc('positions', mint);
}

export async function setPosition(mint, data) {
  invalidateCache('positions');
  return setDoc('positions', mint, { ...data, updatedAt: Date.now() });
}

export async function getAllPositions() {
  const cached = getCached('positions');
  if (cached) return cached;
  const result = await getAllDocs('positions');
  setCache('positions', result);
  return result;
}

// --- runs ---
export async function addRun(data) {
  return addDoc('runs', { ...data, timestamp: Date.now() });
}

export async function getRunsForToken(tokenAddress, limit = 50) {
  return queryDocs('runs', [['tokenAddress', '==', tokenAddress]], 'timestamp', limit);
}

export async function getAllRuns(limit = 100) {
  const runs = await queryDocs('runs', [], 'timestamp', limit);
  // Drop legacy Solana-era runs (keyed by Pump.fun mint, not an EVM address)
  return runs.filter(r => r.tokenAddress && isAddress(r.tokenAddress));
}

// --- buybacks ---
export async function addBuyback(data) {
  return addDoc('buybacks', { ...data, timestamp: Date.now() });
}

export async function getBuybacksForToken(tokenAddress, limit = 50) {
  // Query by equality only (no orderBy) so Firestore doesn't require a
  // composite index — then sort newest-first in memory. Per-token buyback
  // counts are small, so fetching the matches and sorting is cheap.
  const rows = await queryDocs('buybacks', [['tokenAddress', '==', tokenAddress]], null, 500);
  rows.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
  return rows.slice(0, limit);
}

export async function getAllBuybacks(limit = 100) {
  const buybacks = await queryDocs('buybacks', [], 'timestamp', limit);
  // Drop legacy Solana-era buybacks (keyed by Pump.fun mint, not EVM)
  return buybacks.filter(b => b.tokenAddress && isAddress(b.tokenAddress));
}

// --- splits ---
export async function addSplit(data) {
  return addDoc('splits', data);
}

// --- config ---
export async function getConfig(key) {
  return getDoc('config', key);
}

export async function setConfig(key, data) {
  return setDoc('config', key, data);
}

export { db, _mockMode };
