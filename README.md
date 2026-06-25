# Fission Protocol

Perpetual-backed token derivatives on Solana. Creator fees fuel automated perpetual positions via Drift.

## How It Works

1. **Launch on Pump.fun** — Deploy your token with 100% creator fee share allocated to the Fission Protocol wallet. Admin must be revoked.
2. **Register with Fission** — Submit your mint address. We verify on-chain that the fee configuration and admin revocation are correct.
3. **Automated Engine** — Fees are claimed automatically, split into perpetual positions, buybacks, and revenue. Fully autonomous.

## Architecture

```
frontend/          Vite + vanilla JS — landing, dashboard, launch wizard
backend/
  api/             Express REST API — token registration, stats, positions
  services/        Drift SDK integration, Pump.fun verification, Jupiter swaps
  workers/         Autonomous engine — fee claimer, position manager, buyback engine, risk manager
  db/              Firebase Firestore (mock mode when credentials not set)
```

## Getting Started

### Frontend

```bash
npm install
npm run dev          # http://localhost:5173
```

### Backend

```bash
cd backend
npm install
npm start            # http://localhost:3001
```

### Environment Variables

```bash
# backend/.env
PORT=3001
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com
PROTOCOL_WALLET=HgeoK9ASUYey5g2MBSGHfCdauDzLv93x6vAs7j492i9c
FIREBASE_SERVICE_ACCOUNT=./path-to-credentials.json   # omit for mock mode
```

## Tech Stack

- **Frontend**: Vite, vanilla JS, CSS custom properties
- **Backend**: Node.js, Express
- **Perps**: Drift Protocol SDK
- **Swaps**: Jupiter Aggregator
- **Database**: Firebase Firestore
- **Chain**: Solana

## License

MIT
