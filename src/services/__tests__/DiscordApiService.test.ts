/**
 * Unit tests for DiscordApiService.
 *
 * Node 18+ uses undici-based built-in fetch which nock cannot intercept.
 * We mock global.fetch directly with Jest spies to achieve the same isolation.
 *
 * Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 9.1, 9.2
 */

import { DiscordApiService } from '../DiscordApiService';
import {
  AddGuildMemberParams,
  RateLimitError,
  PermissionError,
  DiscordApiError,
} from '../../types';

// ---------------------------------------------------------------------------
// Mock config so the service uses predictable test credentials
// ---------------------------------------------------------------------------
jest.mock('../../config', () => ({
  config: {
    DISCORD_CLIENT_ID: 'test-client-id',
    DISCORD_CLIENT_SECRET: 'test-client-secret',
    DISCORD_REDIRECT_URI: 'https://example.com/auth/discord/callback',
    DISCORD_GUILD_ID: 'test-guild-id',
    DISCORD_BOT_TOKEN: 'test-bot-token',
    COOKIE_SECRET: 'test-cookie-secret',
    IP_HASH_SALT: 'test-ip-salt',
    UA_HASH_SALT: 'test-ua-salt',
    PORT: 3000,
    NODE_ENV: 'test',
    DATABASE_URL: undefined,
    CUSTOM_DM_ENABLED: false,
    CUSTOM_WELCOME_MESSAGE: 'Welcome!',
    REDIRECT_ALLOWLIST: ['/success'],
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DISCORD_API_BASE = 'https://discord.com/api/v10';
const GUILD_MEMBERS_URL = `${DISCORD_API_BASE}/guilds/test-guild-id/members/test-user-id`;
const DM_CHANNEL_URL = `${DISCORD_API_BASE}/users/@me/channels`;

const BASE_PARAMS: AddGuildMemberParams = {
  guildId: 'test-guild-id',
  userId: 'test-user-id',
  accessToken: 'test-access-token',
};

/**
 * Build a minimal Response-like object that satisfies the fetch Response interface.
 */
function makeFetchResponse(
  status: number,
  body: unknown = null,
  headers: Record<string, string> = {},
): Response {
  const headerMap = new Headers(headers);
  return {
    status,
    ok: status >= 200 && status < 300,
    json: () => Promise.resolve(body),
    headers: headerMap,
    redirected: false,
    statusText: String(status),
    type: 'basic',
    url: '',
    clone: () => makeFetchResponse(status, body, headers),
    body: null,
    bodyUsed: false,
    arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)),
    blob: () => Promise.resolve(new Blob([])),
    formData: () => Promise.resolve(new FormData()),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('DiscordApiService', () => {
  let service: DiscordApiService;
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    service = new DiscordApiService();
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // addGuildMember
  // -------------------------------------------------------------------------

  describe('addGuildMember', () => {
    it('returns "added" on HTTP 201 (user newly added to guild)', async () => {
      // Arrange
      fetchSpy.mockResolvedValueOnce(makeFetchResponse(201, { id: 'test-user-id' }));

      // Act
      const result = await service.addGuildMember(BASE_PARAMS);

      // Assert
      expect(result).toBe('added');
    });

    it('returns "already_member" on HTTP 204 (user already in guild)', async () => {
      // Arrange
      fetchSpy.mockResolvedValueOnce(makeFetchResponse(204));

      // Act
      const result = await service.addGuildMember(BASE_PARAMS);

      // Assert
      expect(result).toBe('already_member');
    });

    it('calls the correct Discord guild members endpoint URL', async () => {
      fetchSpy.mockResolvedValueOnce(makeFetchResponse(201));

      await service.addGuildMember(BASE_PARAMS);

      expect(fetchSpy).toHaveBeenCalledWith(
        GUILD_MEMBERS_URL,
        expect.objectContaining({ method: 'PUT' }),
      );
    });

    it('sends Authorization: Bot header with the bot token', async () => {
      fetchSpy.mockResolvedValueOnce(makeFetchResponse(201));

      await service.addGuildMember(BASE_PARAMS);

      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>)['Authorization']).toBe(
        'Bot test-bot-token',
      );
    });

    it('sends the access_token in the JSON body', async () => {
      fetchSpy.mockResolvedValueOnce(makeFetchResponse(201));

      await service.addGuildMember(BASE_PARAMS);

      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.access_token).toBe('test-access-token');
    });

    it('sends Content-Type: application/json', async () => {
      fetchSpy.mockResolvedValueOnce(makeFetchResponse(201));

      await service.addGuildMember(BASE_PARAMS);

      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>)['Content-Type']).toBe(
        'application/json',
      );
    });

    it('includes optional roles in the request body when provided', async () => {
      fetchSpy.mockResolvedValueOnce(makeFetchResponse(201));

      await service.addGuildMember({
        ...BASE_PARAMS,
        roles: ['role-id-1', 'role-id-2'],
      });

      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.roles).toEqual(['role-id-1', 'role-id-2']);
    });

    it('includes optional nick in the request body when provided', async () => {
      fetchSpy.mockResolvedValueOnce(makeFetchResponse(201));

      await service.addGuildMember({ ...BASE_PARAMS, nick: 'CoolNick' });

      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body.nick).toBe('CoolNick');
    });

    it('throws RateLimitError on HTTP 429 with Retry-After header', async () => {
      // Arrange
      fetchSpy.mockResolvedValueOnce(
        makeFetchResponse(429, null, { 'Retry-After': '30' }),
      );

      // Act & Assert
      await expect(service.addGuildMember(BASE_PARAMS)).rejects.toThrow(
        RateLimitError,
      );
    });

    it('RateLimitError carries the parsed Retry-After value as a number', async () => {
      fetchSpy.mockResolvedValueOnce(
        makeFetchResponse(429, null, { 'Retry-After': '42' }),
      );

      let caughtError: RateLimitError | undefined;
      try {
        await service.addGuildMember(BASE_PARAMS);
      } catch (err) {
        caughtError = err as RateLimitError;
      }

      expect(caughtError).toBeInstanceOf(RateLimitError);
      expect(caughtError?.retryAfter).toBe(42);
    });

    it('throws PermissionError on HTTP 403', async () => {
      fetchSpy.mockResolvedValueOnce(
        makeFetchResponse(403, { message: 'Missing Permissions' }),
      );

      await expect(service.addGuildMember(BASE_PARAMS)).rejects.toThrow(
        PermissionError,
      );
    });

    it('PermissionError message indicates bot lacks permission', async () => {
      fetchSpy.mockResolvedValueOnce(
        makeFetchResponse(403, { message: 'Missing Permissions' }),
      );

      let caughtError: PermissionError | undefined;
      try {
        await service.addGuildMember(BASE_PARAMS);
      } catch (err) {
        caughtError = err as PermissionError;
      }

      expect(caughtError).toBeInstanceOf(PermissionError);
      expect(caughtError?.message).toMatch(/permission/i);
    });

    it('throws DiscordApiError on unexpected non-201/204 status (e.g. 500)', async () => {
      fetchSpy.mockResolvedValueOnce(
        makeFetchResponse(500, { message: 'Internal Server Error' }),
      );

      await expect(service.addGuildMember(BASE_PARAMS)).rejects.toThrow(
        DiscordApiError,
      );
    });

    it('DiscordApiError carries the HTTP status code', async () => {
      fetchSpy.mockResolvedValueOnce(
        makeFetchResponse(500, { message: 'Internal Server Error' }),
      );

      let caughtError: DiscordApiError | undefined;
      try {
        await service.addGuildMember(BASE_PARAMS);
      } catch (err) {
        caughtError = err as DiscordApiError;
      }

      expect(caughtError).toBeInstanceOf(DiscordApiError);
      expect(caughtError?.statusCode).toBe(500);
    });

    it('throws DiscordApiError on 400 Bad Request', async () => {
      fetchSpy.mockResolvedValueOnce(
        makeFetchResponse(400, { code: 50035, message: 'Invalid Form Body' }),
      );

      await expect(service.addGuildMember(BASE_PARAMS)).rejects.toThrow(
        DiscordApiError,
      );
    });
  });

  // -------------------------------------------------------------------------
  // sendDirectMessage
  // -------------------------------------------------------------------------

  describe('sendDirectMessage', () => {
    const TEST_USER_ID = 'test-user-id';
    const TEST_CONTENT = 'Welcome to DreamLand! 🎉';
    const DM_CHANNEL_ID = 'dm-channel-id-123';

    it('resolves without error on a successful DM send', async () => {
      // Arrange: first call creates DM channel, second sends the message
      fetchSpy
        .mockResolvedValueOnce(makeFetchResponse(200, { id: DM_CHANNEL_ID }))
        .mockResolvedValueOnce(makeFetchResponse(200, { id: 'message-id' }));

      // Act & Assert
      await expect(
        service.sendDirectMessage(TEST_USER_ID, TEST_CONTENT),
      ).resolves.toBeUndefined();
    });

    it('calls the DM channel creation endpoint first', async () => {
      fetchSpy
        .mockResolvedValueOnce(makeFetchResponse(200, { id: DM_CHANNEL_ID }))
        .mockResolvedValueOnce(makeFetchResponse(200, { id: 'message-id' }));

      await service.sendDirectMessage(TEST_USER_ID, TEST_CONTENT);

      const [firstUrl, firstInit] = fetchSpy.mock.calls[0] as [
        string,
        RequestInit,
      ];
      expect(firstUrl).toBe(DM_CHANNEL_URL);
      expect(firstInit.method).toBe('POST');
    });

    it('sends recipient_id in the DM channel creation body', async () => {
      fetchSpy
        .mockResolvedValueOnce(makeFetchResponse(200, { id: DM_CHANNEL_ID }))
        .mockResolvedValueOnce(makeFetchResponse(200, { id: 'message-id' }));

      await service.sendDirectMessage(TEST_USER_ID, TEST_CONTENT);

      const [, firstInit] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(firstInit.body as string) as Record<
        string,
        unknown
      >;
      expect(body.recipient_id).toBe(TEST_USER_ID);
    });

    it('calls the messages endpoint with the DM channel ID from the first response', async () => {
      fetchSpy
        .mockResolvedValueOnce(makeFetchResponse(200, { id: DM_CHANNEL_ID }))
        .mockResolvedValueOnce(makeFetchResponse(200, { id: 'message-id' }));

      await service.sendDirectMessage(TEST_USER_ID, TEST_CONTENT);

      const [secondUrl] = fetchSpy.mock.calls[1] as [string, RequestInit];
      expect(secondUrl).toBe(
        `${DISCORD_API_BASE}/channels/${DM_CHANNEL_ID}/messages`,
      );
    });

    it('sends the message content in the messages request body', async () => {
      fetchSpy
        .mockResolvedValueOnce(makeFetchResponse(200, { id: DM_CHANNEL_ID }))
        .mockResolvedValueOnce(makeFetchResponse(200, { id: 'message-id' }));

      await service.sendDirectMessage(TEST_USER_ID, TEST_CONTENT);

      const [, secondInit] = fetchSpy.mock.calls[1] as [string, RequestInit];
      const body = JSON.parse(secondInit.body as string) as Record<
        string,
        unknown
      >;
      expect(body.content).toBe(TEST_CONTENT);
    });

    it('sends Authorization: Bot header on both requests', async () => {
      fetchSpy
        .mockResolvedValueOnce(makeFetchResponse(200, { id: DM_CHANNEL_ID }))
        .mockResolvedValueOnce(makeFetchResponse(200, { id: 'message-id' }));

      await service.sendDirectMessage(TEST_USER_ID, TEST_CONTENT);

      for (const call of fetchSpy.mock.calls) {
        const [, init] = call as [string, RequestInit];
        expect((init.headers as Record<string, string>)['Authorization']).toBe(
          'Bot test-bot-token',
        );
      }
    });

    it('throws DiscordApiError when DM channel creation fails (non-200)', async () => {
      // Arrange: channel creation returns 403
      fetchSpy.mockResolvedValueOnce(
        makeFetchResponse(403, { message: 'Cannot send messages to this user' }),
      );

      // Act & Assert
      await expect(
        service.sendDirectMessage(TEST_USER_ID, TEST_CONTENT),
      ).rejects.toThrow(DiscordApiError);
    });

    it('DiscordApiError from channel creation carries the HTTP status code', async () => {
      fetchSpy.mockResolvedValueOnce(makeFetchResponse(403, null));

      let caughtError: DiscordApiError | undefined;
      try {
        await service.sendDirectMessage(TEST_USER_ID, TEST_CONTENT);
      } catch (err) {
        caughtError = err as DiscordApiError;
      }

      expect(caughtError).toBeInstanceOf(DiscordApiError);
      expect(caughtError?.statusCode).toBe(403);
    });

    it('does not call the messages endpoint when channel creation fails', async () => {
      fetchSpy.mockResolvedValueOnce(makeFetchResponse(500, null));

      try {
        await service.sendDirectMessage(TEST_USER_ID, TEST_CONTENT);
      } catch {
        // expected
      }

      // Only one fetch call should have been made (the channel creation)
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('throws DiscordApiError when message send fails (non-200)', async () => {
      fetchSpy
        .mockResolvedValueOnce(makeFetchResponse(200, { id: DM_CHANNEL_ID }))
        .mockResolvedValueOnce(makeFetchResponse(400, { message: 'Bad Request' }));

      await expect(
        service.sendDirectMessage(TEST_USER_ID, TEST_CONTENT),
      ).rejects.toThrow(DiscordApiError);
    });

    it('DiscordApiError from message send carries the HTTP status code', async () => {
      fetchSpy
        .mockResolvedValueOnce(makeFetchResponse(200, { id: DM_CHANNEL_ID }))
        .mockResolvedValueOnce(makeFetchResponse(400, null));

      let caughtError: DiscordApiError | undefined;
      try {
        await service.sendDirectMessage(TEST_USER_ID, TEST_CONTENT);
      } catch (err) {
        caughtError = err as DiscordApiError;
      }

      expect(caughtError).toBeInstanceOf(DiscordApiError);
      expect(caughtError?.statusCode).toBe(400);
    });
  });
});
