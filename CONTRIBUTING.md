# Contributing to Fission Protocol

Thanks for your interest in contributing. This document outlines the process for contributing to the project.

## Development Setup

### Prerequisites

- Node.js 18+
- npm 9+

### Quick Start

```bash
# Clone the repo
git clone https://github.com/FissionDotFun/fission.git
cd fission

# Frontend
npm install
npm run dev

# Backend (separate terminal)
cd backend
npm install
cp .env.example .env
npm start
```

The frontend runs at `http://localhost:5173` and the backend at `http://localhost:3001`. The backend starts in mock mode by default — no Firebase credentials needed.

## Project Structure

```
src/           Frontend (Vite + vanilla JS)
backend/       Backend (Express + Drift SDK)
  api/         REST controllers and routes
  services/    Drift, Jupiter, Pump.fun, Solana integrations
  workers/     Autonomous engine workers
  db/          Firebase with mock fallback
```

## Making Changes

1. Fork the repo and create a branch from `main`
2. Make your changes
3. Ensure the frontend builds: `npm run build`
4. Ensure the backend starts: `cd backend && npm start`
5. Open a pull request

## Commit Messages

Use clear, descriptive commit messages:

```
Add risk manager drawdown threshold
Fix ticker price formatting for sub-cent tokens
Refactor dashboard to use server-side sorting
```

## Code Style

- Vanilla JS — no frameworks, no TypeScript
- CSS custom properties for all design tokens
- ES modules throughout
- Descriptive variable names, minimal comments
- Functions should do one thing

## Reporting Issues

Use the issue templates:
- **Bug reports** — describe what happened vs. what you expected
- **Feature requests** — describe the problem before proposing a solution

## Security

See [SECURITY.md](SECURITY.md) for vulnerability reporting. Do not open public issues for security bugs.
