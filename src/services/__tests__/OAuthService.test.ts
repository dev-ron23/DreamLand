/**
 * Unit tests for OAuthService.
 *
 * Node 18+ uses undici-based built-in fetch which nock cannot intercept.
 * We mock global.fetch directly with Jest spies to achieve the same isolation.
 *
 * Requirements: 4.1, 4.2, 4.3, 4.4, 5.1, 5.2, 5.3
 */

import { OAuthService } from '../OAuthService';
import { OAuthError, TokenResponse, DiscordUser } from '../../types';

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

const DISCORD_TOKEN_URL = 'https://discord.com/api/v10/oauth2/token';
const DISCORD_USER_URL = 'https://discord.com/api/v10/users/@me';

const VALID_TOKEN_RESPONSE: TokenResponse = {
  access_token: 'mock-access-token',
  token_type: 'Bearer',
  expires_in: 604800,
  refresh_token: 'mock-refresh-token',
  scope: 'identify guilds.join',
};

const VALID_DISCORD_USER: DiscordUser = {
  id: '123456789012345678',
  username: 'testuser',
  discriminator: '0',
  avatar: null,
};

/**
 * Build a minimal Response-like object that satisfies the fetch Response interface
 * used by OAuthService (status, json()).
 */
function makeFetchResponse(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: () => Promise.resolve(body),
    headers: new Headers(),
    redirected: false,
    statusText: String(status),
    type: 'basic',
    url: '',
    clone: () => makeFetchResponse(status, body),
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

describe('OAuthService', () => {
  let service: OAuthService;
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    service = new OAuthService();
    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // exchangeCodeForToken
  // -------------------------------------------------------------------------

  describe('exchangeCodeForToken', () => {
    const TEST_CODE = 'auth-code-abc123';
    const TEST_REDIRECT_URI = 'https://example.com/auth/discord/callback';

    it('returns a TokenResponse on a 200 response with guilds.join scope', async () => {
      // Arrange
      fetchSpy.mockResolvedValueOnce(makeFetchResponse(200, VALID_TOKEN_RESPONSE));

      // Act
      const result = await service.exchangeCodeForToken(TEST_CODE, TEST_REDIRECT_URI);

      // Assert
      expect(result).toEqual(VALID_TOKEN_RESPONSE);
      expect(result.access_token).toBe('mock-access-token');
      expect(result.scope).toContain('guilds.join');
    });

    it('calls the correct Discord token endpoint URL', async () => {
      fetchSpy.mockResolvedValueOnce(makeFetchResponse(200, VALID_TOKEN_RESPONSE));

      await service.exchangeCodeForToken(TEST_CODE, TEST_REDIRECT_URI);

      expect(fetchSpy).toHaveBeenCalledWith(
        DISCORD_TOKEN_URL,
        expect.objectContaining({ method: 'POST' }),
      );
    });

    it('sends the correct form-encoded body fields to Discord', async () => {
      fetchSpy.mockResolvedValueOnce(makeFetchResponse(200, VALID_TOKEN_RESPONSE));

      await service.exchangeCodeForToken(TEST_CODE, TEST_REDIRECT_URI);

      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const body = init.body as string;

      expect(body).toContain('client_id=test-client-id');
      expect(body).toContain('grant_type=authorization_code');
      expect(body).toContain(`code=${TEST_CODE}`);
      expect(body).toContain(
        `redirect_uri=${encodeURIComponent(TEST_REDIRECT_URI)}`,
      );
      // client_secret must be sent (value is present, not logged)
      expect(body).toContain('client_secret=test-client-secret');
    });

    it('sends Content-Type: application/x-www-form-urlencoded', async () => {
      fetchSpy.mockResolvedValueOnce(makeFetchResponse(200, VALID_TOKEN_RESPONSE));

      await service.exchangeCodeForToken(TEST_CODE, TEST_REDIRECT_URI);

      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>)['Content-Type']).toBe(
        'application/x-www-form-urlencoded',
      );
    });

    it('throws OAuthError when Discord returns a non-200 status (400)', async () => {
      fetchSpy.mockResolvedValueOnce(
        makeFetchResponse(400, { error: 'invalid_grant', error_description: 'Invalid code' }),
      );

      await expect(
        service.exchangeCodeForToken(TEST_CODE, TEST_REDIRECT_URI),
      ).rejects.toThrow(OAuthError);

      fetchSpy.mockResolvedValueOnce(
        makeFetchResponse(400, { error: 'invalid_grant' }),
      );
      await expect(
        service.exchangeCodeForToken(TEST_CODE, TEST_REDIRECT_URI),
      ).rejects.toThrow('Token exchange failed with status 400');
    });

    it('includes the Discord error code in the thrown OAuthError', async () => {
      fetchSpy.mockResolvedValueOnce(
        makeFetchResponse(400, { error: 'invalid_grant' }),
      );

      let caughtError: OAuthError | undefined;
      try {
        await service.exchangeCodeForToken(TEST_CODE, TEST_REDIRECT_URI);
      } catch (err) {
        caughtError = err as OAuthError;
      }

      expect(caughtError).toBeInstanceOf(OAuthError);
      expect(caughtError?.discordError).toBe('invalid_grant');
    });

    it('throws OAuthError on 401 Unauthorized', async () => {
      fetchSpy.mockResolvedValueOnce(
        makeFetchResponse(401, { error: 'unauthorized' }),
      );

      await expect(
        service.exchangeCodeForToken(TEST_CODE, TEST_REDIRECT_URI),
      ).rejects.toThrow(OAuthError);
    });

    it('throws OAuthError on 500 server error', async () => {
      fetchSpy.mockResolvedValueOnce(
        makeFetchResponse(500, { error: 'internal_server_error' }),
      );

      await expect(
        service.exchangeCodeForToken(TEST_CODE, TEST_REDIRECT_URI),
      ).rejects.toThrow(OAuthError);
    });

    it('throws OAuthError when scope is missing guilds.join', async () => {
      const responseWithoutGuildsJoin: TokenResponse = {
        ...VALID_TOKEN_RESPONSE,
        scope: 'identify',
      };
      fetchSpy.mockResolvedValueOnce(makeFetchResponse(200, responseWithoutGuildsJoin));

      await expect(
        service.exchangeCodeForToken(TEST_CODE, TEST_REDIRECT_URI),
      ).rejects.toThrow(OAuthError);

      fetchSpy.mockResolvedValueOnce(makeFetchResponse(200, responseWithoutGuildsJoin));
      await expect(
        service.exchangeCodeForToken(TEST_CODE, TEST_REDIRECT_URI),
      ).rejects.toThrow('Missing required scope: guilds.join');
    });

    it('throws OAuthError when scope is an empty string', async () => {
      const responseEmptyScope = { ...VALID_TOKEN_RESPONSE, scope: '' };
      fetchSpy.mockResolvedValueOnce(makeFetchResponse(200, responseEmptyScope));

      await expect(
        service.exchangeCodeForToken(TEST_CODE, TEST_REDIRECT_URI),
      ).rejects.toThrow(OAuthError);
    });

    it('accepts a scope string that contains guilds.join among other scopes', async () => {
      const responseMultiScope: TokenResponse = {
        ...VALID_TOKEN_RESPONSE,
        scope: 'identify guilds.join email',
      };
      fetchSpy.mockResolvedValueOnce(makeFetchResponse(200, responseMultiScope));

      const result = await service.exchangeCodeForToken(TEST_CODE, TEST_REDIRECT_URI);
      expect(result.scope).toContain('guilds.join');
    });
  });

  // -------------------------------------------------------------------------
  // getDiscordUser
  // -------------------------------------------------------------------------

  describe('getDiscordUser', () => {
    const TEST_ACCESS_TOKEN = 'valid-bearer-token';

    it('returns a DiscordUser on a 200 response', async () => {
      fetchSpy.mockResolvedValueOnce(makeFetchResponse(200, VALID_DISCORD_USER));

      const result = await service.getDiscordUser(TEST_ACCESS_TOKEN);

      expect(result).toEqual(VALID_DISCORD_USER);
      expect(result.id).toBe('123456789012345678');
      expect(result.username).toBe('testuser');
    });

    it('calls the correct Discord user endpoint URL', async () => {
      fetchSpy.mockResolvedValueOnce(makeFetchResponse(200, VALID_DISCORD_USER));

      await service.getDiscordUser(TEST_ACCESS_TOKEN);

      expect(fetchSpy).toHaveBeenCalledWith(
        DISCORD_USER_URL,
        expect.objectContaining({ method: 'GET' }),
      );
    });

    it('sends the Authorization: Bearer header with the access token', async () => {
      fetchSpy.mockResolvedValueOnce(makeFetchResponse(200, VALID_DISCORD_USER));

      await service.getDiscordUser(TEST_ACCESS_TOKEN);

      const [, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
      expect((init.headers as Record<string, string>)['Authorization']).toBe(
        `Bearer ${TEST_ACCESS_TOKEN}`,
      );
    });

    it('throws OAuthError when Discord returns a non-200 status (401)', async () => {
      fetchSpy.mockResolvedValueOnce(
        makeFetchResponse(401, { message: '401: Unauthorized', code: 0 }),
      );

      await expect(service.getDiscordUser(TEST_ACCESS_TOKEN)).rejects.toThrow(
        OAuthError,
      );

      fetchSpy.mockResolvedValueOnce(
        makeFetchResponse(401, { message: '401: Unauthorized' }),
      );
      await expect(service.getDiscordUser(TEST_ACCESS_TOKEN)).rejects.toThrow(
        'Failed to fetch Discord user with status 401',
      );
    });

    it('throws OAuthError on 403 Forbidden', async () => {
      fetchSpy.mockResolvedValueOnce(
        makeFetchResponse(403, { message: 'Missing Permissions' }),
      );

      await expect(service.getDiscordUser(TEST_ACCESS_TOKEN)).rejects.toThrow(
        OAuthError,
      );
    });

    it('throws OAuthError on 500 server error', async () => {
      fetchSpy.mockResolvedValueOnce(
        makeFetchResponse(500, { message: 'Internal Server Error' }),
      );

      await expect(service.getDiscordUser(TEST_ACCESS_TOKEN)).rejects.toThrow(
        OAuthError,
      );
    });

    it('returns a user with a null avatar', async () => {
      const userWithNullAvatar: DiscordUser = { ...VALID_DISCORD_USER, avatar: null };
      fetchSpy.mockResolvedValueOnce(makeFetchResponse(200, userWithNullAvatar));

      const result = await service.getDiscordUser(TEST_ACCESS_TOKEN);
      expect(result.avatar).toBeNull();
    });

    it('returns a user with an avatar hash', async () => {
      const userWithAvatar: DiscordUser = {
        ...VALID_DISCORD_USER,
        avatar: 'a_1234567890abcdef',
      };
      fetchSpy.mockResolvedValueOnce(makeFetchResponse(200, userWithAvatar));

      const result = await service.getDiscordUser(TEST_ACCESS_TOKEN);
      expect(result.avatar).toBe('a_1234567890abcdef');
    });
  });
});
