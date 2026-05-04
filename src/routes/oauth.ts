/**
 * OAuthController — Express router for the Discord OAuth2 join flow.
 *
 * Handles two routes:
 *   GET /auth/discord          — Initiate the OAuth2 flow (Task 11.1)
 *   GET /auth/discord/callback — Handle the OAuth2 callback (Task 11.2)
 *
 * Security notes:
 *  - OAuth2 access tokens, bot tokens, and authorization codes are NEVER
 *    included in redirect URLs or log output.
 *  - The oauth_state cookie is cleared on the first callback attempt,
 *    regardless of whether validation succeeds or fails (Requirement 10.5).
 *
 * Requirements: 2.1–2.4, 3.1–3.8, 4.3, 4.4, 5.3, 6.6, 7.1–7.3,
 *               8.5, 9.3–9.5, 10.1–10.6, 11.2, 11.3, 12.1–12.4,
 *               15.1–15.9
 */

import { Router } from 'express';
import { config } from '../config';
import {
  generateStateToken,
  buildAuthorizationUrl,
  validateState,
  hashForAnalytics,
} from '../lib/oauth';
import { joinRateLimiter, callbackRateLimiter } from '../middleware/rateLimiter';
import { OAuthService } from '../services/OAuthService';
import { DiscordApiService } from '../services/DiscordApiService';
import { UserRepository } from '../repositories/UserRepository';
import { RateLimitError, PermissionError } from '../types';

// ---------------------------------------------------------------------------
// Module-level service instances
// ---------------------------------------------------------------------------

const oauthService = new OAuthService();
const discordApiService = new DiscordApiService();
const userRepository = new UserRepository();

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const oauthRouter = Router();

// ---------------------------------------------------------------------------
// GET /auth/discord — Initiate OAuth2 flow (Task 11.1)
// Requirements: 2.1, 2.2, 2.3, 2.4, 10.1, 10.2, 10.3, 11.2, 11.3
// ---------------------------------------------------------------------------

oauthRouter.get('/discord', joinRateLimiter, (req, res) => {
  // Generate a cryptographically random 64-char hex CSRF state token
  const stateToken = generateStateToken();

  // Build the OAuthState payload to store in the cookie
  const statePayload = JSON.stringify({ token: stateToken, createdAt: Date.now() });

  // Store the state in a signed, httpOnly, secure, sameSite=lax cookie
  // maxAge is in milliseconds: 10 minutes = 600_000 ms
  res.cookie('oauth_state', statePayload, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    maxAge: 600_000,
    signed: true,
  });

  // Build the Discord authorization URL and redirect (HTTP 302)
  const authUrl = buildAuthorizationUrl(stateToken);
  res.redirect(302, authUrl);
});

// ---------------------------------------------------------------------------
// GET /auth/discord/callback — Handle OAuth2 callback (Task 11.2)
// Requirements: 3.1–3.8, 4.3, 4.4, 5.3, 6.6, 7.1–7.3, 8.5, 9.3–9.5,
//               10.4, 10.5, 10.6, 12.1–12.4, 15.1–15.9
// ---------------------------------------------------------------------------

oauthRouter.get('/discord/callback', callbackRateLimiter, async (req, res) => {
  const { error, code, state } = req.query as {
    error?: string;
    code?: string;
    state?: string;
  };

  // Step 1a: Handle Discord's access_denied error (Requirement 3.6)
  if (error === 'access_denied') {
    return res.redirect('/error?reason=access_denied');
  }

  // Step 1b: Handle missing authorization code (Requirement 3.5)
  if (!code) {
    return res.redirect('/error?reason=invalid_state');
  }

  // Step 2: Validate CSRF state (Requirements 3.1, 3.2, 3.3, 10.4, 10.6)
  const cookieValue: string | undefined = req.signedCookies['oauth_state'] as string | undefined;
  const stateResult = validateState(cookieValue, state);

  // Step 3: Clear the state cookie immediately — one-time use regardless of
  // validation outcome (Requirements 3.4, 10.5)
  res.clearCookie('oauth_state');

  if (!stateResult.valid) {
    if (stateResult.reason === 'expired') {
      // Requirement 15.2: log at info level for expired state
      console.info('[oauth] State cookie expired — redirecting to state_expired');
      return res.redirect('/error?reason=state_expired');
    }
    // Requirement 15.1: log at warn level for invalid/missing/mismatched state
    console.warn('[oauth] State validation failed:', stateResult.reason);
    return res.redirect('/error?reason=invalid_state');
  }

  // Step 4: Exchange authorization code for access token (Requirements 4.3, 4.4)
  let tokenResponse;
  try {
    tokenResponse = await oauthService.exchangeCodeForToken(
      code,
      config.DISCORD_REDIRECT_URI,
    );
  } catch (err) {
    // Requirement 15.3: log at error level — never log the code itself
    console.error('[oauth] Token exchange failed:', err instanceof Error ? err.message : err);
    return res.redirect('/error?reason=token_exchange_failed');
  }

  // Step 5: Fetch Discord user identity (Requirement 5.3)
  let discordUser;
  try {
    discordUser = await oauthService.getDiscordUser(tokenResponse.access_token);
  } catch (err) {
    // Requirement 15.4: log at error level
    console.error('[oauth] User fetch failed:', err instanceof Error ? err.message : err);
    return res.redirect('/error?reason=user_fetch_failed');
  }

  // Step 6: Add user to guild (Requirement 6.6)
  let result;
  try {
    result = await discordApiService.addGuildMember({
      guildId: config.DISCORD_GUILD_ID,
      userId: discordUser.id,
      accessToken: tokenResponse.access_token,
    });
  } catch (err) {
    if (err instanceof RateLimitError) {
      // Requirement 15.6: log at warn level with Retry-After value
      console.warn(
        `[oauth] Guild join rate limited — Retry-After: ${err.retryAfter}s`,
      );
    } else if (err instanceof PermissionError) {
      // Requirement 15.5: log at error level for permission errors
      console.error('[oauth] Guild join permission error:', err.message);
    } else {
      console.error('[oauth] Guild join failed:', err instanceof Error ? err.message : err);
    }
    return res.redirect('/error?reason=guild_join_failed');
  }

  // Step 7: Persist user and join event to database (Requirement 8.5)
  // Errors are non-fatal — log and continue to success redirect
  try {
    await userRepository.upsertUser(discordUser);
    await userRepository.recordJoinEvent({
      discord_id: discordUser.id,
      result,
      ip_hash: hashForAnalytics(req.ip ?? '', config.IP_HASH_SALT),
      user_agent_hash: hashForAnalytics(
        req.headers['user-agent'] ?? '',
        config.UA_HASH_SALT,
      ),
    });
  } catch (err) {
    // Requirement 15.7: log at error level with full stack trace; still redirect to success
    console.error('[oauth] Database persistence failed:', err);
  }

  // Step 8: Send optional custom welcome DM (Requirements 9.3, 9.4, 9.5)
  if (config.CUSTOM_DM_ENABLED === true && result === 'added') {
    try {
      await discordApiService.sendDirectMessage(
        discordUser.id,
        config.CUSTOM_WELCOME_MESSAGE,
      );
    } catch (err) {
      // Requirement 15.8: log at warn level — DM failure is non-fatal
      console.warn('[oauth] Custom DM failed (non-fatal):', err instanceof Error ? err.message : err);
    }
  }

  // Step 9: Redirect to success page (Requirements 7.1, 7.2, 7.3)
  // NOTE: access tokens are never included in redirect URLs
  if (result === 'already_member') {
    return res.redirect('/success?already_member=true');
  }
  return res.redirect('/success');
});
