/**
 * Application entry point.
 *
 * `dotenv.config()` MUST be called before any other import so that
 * `process.env` is fully populated before `src/config.ts` reads it.
 *
 * - Local dev: starts an HTTP server on config.PORT
 * - Vercel: exports `app` as the default export (serverless handler)
 */

// eslint-disable-next-line @typescript-eslint/no-require-imports
require('dotenv').config();

// These imports must come AFTER dotenv.config() so that config.ts can read
// the populated process.env at module load time.
import app from './app';
import { config } from './config';

// Export for Vercel serverless runtime
export default app;

// Start local server when not running in a serverless environment
if (process.env['VERCEL'] !== '1') {
  app.listen(config.PORT, () => {
    console.log(`[server] Listening on port ${config.PORT} (${config.NODE_ENV})`);
  });
}
