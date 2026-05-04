/**
 * OAuthService — Discord OAuth2 token exchange and user profile retrieval.
 *
 * Responsibilities:
 *  - Exchange an authorization code for a TokenResponse (POST /oauth2/token)
 *  - Fetch the authenticated user's Discord profile (GET /users/@me)
 *
 * Security notes:
 *  - The authorization code and client_secret are NEVER logged.
 *  - The access token is NEVER logged.
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 5.1, 5.2, 5.3, 5.4
 */

import { config } from '../config';
import { OAuthError, TokenResponse, DiscordUser } from '../types';

const DISCORD_TOKEN_URL = 'https://discord.com/api/v10/oauth2/token';
const DISCORD_USER_URL = 'https://discord.com/api/v10/users/@me';

export class OAuthService {
  /**
   * Exchange a Discord authorization code for an access token.
   *
   * @param code        - The authorization code received from Discord's callback.
   * @param redirectUri - The redirect URI used when initiating the OAuth2 flow.
   *                      Must match the value registered in the Discord application.
   * @returns           A `TokenResponse` containing the access token and granted scopes.
   * @throws  OAuthError  When Discord returns a non-200 response.
   * @throws  OAuthError  When the granted scope does not include `guilds.join`.
   *
   * Requirements: 4.1, 4.2, 4.3, 4.4, 4.5
   */
  async exchangeCodeForToken(
    code: string,
    redirectUri: string,
  ): Promise<TokenResponse> {
    const body = new URLSearchParams({
      client_id: config.DISCORD_CLIENT_ID,
      client_secret: config.DISCORD_CLIENT_SECRET,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
    });

    const response = await fetch(DISCORD_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (response.status !== 200) {
      let discordError: string | undefined;
      try {
        const errorBody = (await response.json()) as { error?: string };
        discordError = errorBody.error;
      } catch {
        // Ignore JSON parse errors — we still throw OAuthError below
      }
      // NOTE: code and client_secret are intentionally omitted from this log
      throw new OAuthError(
        `Token exchange failed with status ${response.status}`,
        discordError,
      );
    }

    const tokenData = (await response.json()) as TokenResponse;

    // Validate that the granted scope includes guilds.join (Requirement 4.4)
    const grantedScopes = (tokenData.scope ?? '').split(' ');
    if (!grantedScopes.includes('guilds.join')) {
      throw new OAuthError(
        'Missing required scope: guilds.join',
        'insufficient_scope',
      );
    }

    return tokenData;
  }

  /**
   * Fetch the Discord user profile for the authenticated user.
   *
   * @param accessToken - A valid Bearer access token with the `identify` scope.
   * @returns           A `DiscordUser` object with the user's id, username, etc.
   * @throws  OAuthError  When Discord returns a non-200 response.
   *
   * Requirements: 5.1, 5.2, 5.3, 5.4
   */
  async getDiscordUser(accessToken: string): Promise<DiscordUser> {
    const response = await fetch(DISCORD_USER_URL, {
      method: 'GET',
      // NOTE: accessToken is intentionally not logged anywhere in this method
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (response.status !== 200) {
      throw new OAuthError(
        `Failed to fetch Discord user with status ${response.status}`,
      );
    }

    return (await response.json()) as DiscordUser;
  }
}
