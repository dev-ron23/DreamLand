/**
 * Express application factory.
 *
 * This module creates and configures the Express app with all middleware and
 * routes, then exports it as the default export so it can be imported by
 * `src/server.ts` (entry point) and by integration tests via Supertest.
 *
 * NOTE: This module does NOT call `dotenv.config()`. The entry point
 * (`src/server.ts`) must call `dotenv.config()` before importing this module
 * so that `src/config.ts` can read the populated `process.env`.
 *
 * Requirements: 11.1, 11.2, 16.1
 */

import express from 'express';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import path from 'path';
import { config } from './config';
import { oauthRouter } from './routes/oauth';

// ---------------------------------------------------------------------------
// App factory
// ---------------------------------------------------------------------------

const app = express();

// ---------------------------------------------------------------------------
// Security headers (Requirement 11.1)
//
// helmet() sets a suite of security-related HTTP response headers:
//   - X-Frame-Options: DENY  (via frameguard)
//   - Content-Security-Policy (via contentSecurityPolicy)
//   - X-Content-Type-Options: nosniff
//   - Strict-Transport-Security (HSTS)
//   - …and several others
// ---------------------------------------------------------------------------

app.use(
  helmet({
    frameguard: { action: 'deny' },
  }),
);

// ---------------------------------------------------------------------------
// Cookie parser with signed-cookie support (Requirement 11.2, 16.1)
//
// Passing `config.COOKIE_SECRET` enables `req.signedCookies` so that the
// oauth_state cookie signature can be verified on the callback route.
// ---------------------------------------------------------------------------

app.use(cookieParser(config.COOKIE_SECRET));

// ---------------------------------------------------------------------------
// Static file serving (Requirement 1.1, 1.2, 1.4)
//
// `__dirname` resolves to `dist/` after compilation, so we go one level up
// to reach the project root where `public/` lives.
// ---------------------------------------------------------------------------

app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));

// ---------------------------------------------------------------------------
// OAuth2 routes (Requirements 2.x, 3.x)
// ---------------------------------------------------------------------------

app.use('/auth', oauthRouter);

// ---------------------------------------------------------------------------
// Default export — used by server.ts and Supertest integration tests
// ---------------------------------------------------------------------------

export default app;
