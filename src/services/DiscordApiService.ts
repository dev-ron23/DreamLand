/**
 * DiscordApiService — Discord REST API calls for guild membership and DMs.
 *
 * Responsibilities:
 *  - Add a user to a Discord guild via PUT /guilds/{guildId}/members/{userId}
 *  - Send a direct message to a user via the DM channel API
 *
 * Security notes:
 *  - The access token and bot token are NEVER logged.
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.7, 9.1, 9.2
 */

import { config } from '../config';
import {
  AddGuildMemberParams,
  AddGuildMemberResult,
  RateLimitError,
  PermissionError,
  DiscordApiError,
} from '../types';

const DISCORD_API_BASE = 'https://discord.com/api/v10';

export class DiscordApiService {
  /**
   * Add a user to a Discord guild using their OAuth2 access token.
   *
   * @param params - Guild ID, user ID, access token, and optional roles/nick.
   * @returns      `'added'` if the user was newly added (HTTP 201),
   *               `'already_member'` if they were already in the guild (HTTP 204).
   * @throws RateLimitError   On HTTP 429 — includes the `Retry-After` value in seconds.
   * @throws PermissionError  On HTTP 403 — bot lacks permission to add members.
   * @throws DiscordApiError  On any other non-201/204 response.
   *
   * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 6.7
   */
  async addGuildMember(
    params: AddGuildMemberParams,
  ): Promise<AddGuildMemberResult> {
    const { guildId, userId, accessToken, roles, nick } = params;

    const url = `${DISCORD_API_BASE}/guilds/${guildId}/members/${userId}`;

    const bodyObj: Record<string, unknown> = {
      access_token: accessToken,
    };
    if (roles !== undefined && roles.length > 0) {
      bodyObj.roles = roles;
    }
    if (nick !== undefined && nick.length > 0) {
      bodyObj.nick = nick;
    }

    const response = await fetch(url, {
      method: 'PUT',
      headers: {
        // NOTE: bot token is intentionally not logged anywhere in this method
        Authorization: `Bot ${config.DISCORD_BOT_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(bodyObj),
    });

    if (response.status === 201) {
      return 'added';
    }

    if (response.status === 204) {
      return 'already_member';
    }

    if (response.status === 429) {
      const retryAfterHeader = response.headers.get('Retry-After');
      const retryAfter = retryAfterHeader !== null ? Number(retryAfterHeader) : 0;
      throw new RateLimitError('Discord rate limit hit', retryAfter);
    }

    if (response.status === 403) {
      throw new PermissionError('Bot lacks permission to add members');
    }

    // Any other non-success status
    let errorBody: unknown;
    try {
      errorBody = await response.json();
    } catch {
      errorBody = null;
    }
    throw new DiscordApiError(
      `Discord API error adding guild member: status ${response.status}`,
      response.status,
      errorBody,
    );
  }

  /**
   * Send a direct message to a Discord user via the bot.
   *
   * Creates (or retrieves) a DM channel with the user, then posts the message.
   * Errors are thrown as `DiscordApiError` — callers should treat this as non-fatal.
   *
   * @param userId  - The Discord snowflake ID of the recipient.
   * @param content - The message text (≤ 2000 characters).
   * @throws DiscordApiError  On failure to create the DM channel or send the message.
   *
   * Requirements: 9.1, 9.2
   */
  async sendDirectMessage(userId: string, content: string): Promise<void> {
    // Step 1: Create or retrieve the DM channel
    const dmChannelResponse = await fetch(
      `${DISCORD_API_BASE}/users/@me/channels`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bot ${config.DISCORD_BOT_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ recipient_id: userId }),
      },
    );

    if (dmChannelResponse.status !== 200) {
      throw new DiscordApiError(
        `Failed to create DM channel: status ${dmChannelResponse.status}`,
        dmChannelResponse.status,
        null,
      );
    }

    const dmChannel = (await dmChannelResponse.json()) as { id: string };

    // Step 2: Send the message to the DM channel
    const msgResponse = await fetch(
      `${DISCORD_API_BASE}/channels/${dmChannel.id}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bot ${config.DISCORD_BOT_TOKEN}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ content }),
      },
    );

    if (msgResponse.status !== 200) {
      throw new DiscordApiError(
        `Failed to send DM: status ${msgResponse.status}`,
        msgResponse.status,
        null,
      );
    }
  }
}
