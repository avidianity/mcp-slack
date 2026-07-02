import webApiDefault from '@slack/web-api';
import * as webApiNamespace from '@slack/web-api';
import type { WebAPICallResult, WebClient } from '@slack/web-api';
import type { Config } from '@/config.ts';

// Destructure through the default export, falling back to the namespace:
// @slack/web-api is CommonJS, so named ESM imports of its getter-based
// re-exports (e.g. `retryPolicies`) break on Node 20's export detection,
// while CJS-bundled interop honors `__esModule` and leaves the default unset.
const {
  WebClient: SlackWebClient,
  retryPolicies,
  ErrorCode,
} = (webApiDefault as typeof webApiDefault | undefined) ?? webApiNamespace;

/**
 * Token-selection policy for a tool.
 *
 * - `bot-preferred`  → bot client, falling back to the user client.
 * - `user-preferred` → user client, falling back to the bot client.
 * - `user-required`  → user client only; errors if no user token is configured.
 */
export type TokenPolicy = 'bot-preferred' | 'user-preferred' | 'user-required';

/** Error raised when a tool cannot obtain a client for its token policy. */
export class SlackAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SlackAuthError';
  }
}

/** Normalized Slack API error with an agent-readable message. */
export class SlackApiError extends Error {
  readonly slackError: string | undefined;
  readonly retryAfter: number | undefined;

  constructor(message: string, slackError?: string, retryAfter?: number) {
    super(message);
    this.name = 'SlackApiError';
    this.slackError = slackError;
    this.retryAfter = retryAfter;
  }
}

interface SlackErrorLike {
  code?: string;
  data?: { error?: string; response_metadata?: { messages?: string[] } };
  retryAfter?: number;
  message?: string;
}

/**
 * Thin wrapper around `@slack/web-api` holding up to two `WebClient`s (one per
 * token) and encapsulating token-selection policy. Returns raw Slack response
 * data — formatting/TOON concerns live in `src/format`.
 */
export class SlackClient {
  private readonly bot: WebClient | undefined;
  private readonly user: WebClient | undefined;

  readonly teamId: string | undefined;
  readonly channelIds: readonly string[];

  constructor(config: Config) {
    const options = {
      retryConfig: retryPolicies.fiveRetriesInFiveMinutes,
    };
    this.bot =
      config.botToken !== undefined ? new SlackWebClient(config.botToken, options) : undefined;
    this.user =
      config.userToken !== undefined ? new SlackWebClient(config.userToken, options) : undefined;
    this.teamId = config.teamId;
    this.channelIds = config.channelIds;
  }

  /**
   * Enforce the configured channel allowlist as a real access boundary.
   *
   * When `SLACK_CHANNEL_IDS` is set, any channel-scoped tool call must target a
   * channel in the list; otherwise it is rejected before reaching Slack. A
   * missing channel argument (e.g. workspace-wide listing) is always allowed.
   * The allowlist holds channel IDs, so callers must pass IDs (not names) for
   * the check to succeed.
   */
  assertChannelAllowed(channel: string | undefined): void {
    if (channel === undefined || this.channelIds.length === 0) {
      return;
    }
    if (!this.channelIds.includes(channel)) {
      throw new SlackAuthError(
        `Channel ${channel} is not in the configured SLACK_CHANNEL_IDS allowlist.`,
      );
    }
  }

  /** Resolve the `WebClient` to use for the given policy, or throw. */
  clientFor(policy: TokenPolicy): WebClient {
    switch (policy) {
      case 'bot-preferred': {
        const client = this.bot ?? this.user;
        if (client === undefined) {
          throw new SlackAuthError('No Slack token is configured.');
        }
        return client;
      }
      case 'user-preferred': {
        const client = this.user ?? this.bot;
        if (client === undefined) {
          throw new SlackAuthError('No Slack token is configured.');
        }
        return client;
      }
      case 'user-required': {
        if (this.user === undefined) {
          throw new SlackAuthError(
            'This tool requires a user token. Set SLACK_USER_TOKEN (xoxp-...) to use it.',
          );
        }
        return this.user;
      }
    }
  }

  /**
   * Invoke a Slack API call with a policy-selected client, normalizing any
   * error into a `SlackApiError` / `SlackAuthError`.
   */
  async call<T = WebAPICallResult>(
    policy: TokenPolicy,
    fn: (client: WebClient) => Promise<WebAPICallResult>,
  ): Promise<T> {
    const client = this.clientFor(policy);
    try {
      return (await fn(client)) as T;
    } catch (error) {
      throw normalizeSlackError(error);
    }
  }
}

function normalizeSlackError(error: unknown): SlackApiError | SlackAuthError {
  if (error instanceof SlackAuthError) {
    return error;
  }

  const err = error as SlackErrorLike;

  if (err.code === ErrorCode.RateLimitedError) {
    const retryAfter = err.retryAfter;
    return new SlackApiError(
      `Slack rate limit hit${retryAfter !== undefined ? `; retry after ${retryAfter}s` : ''}.`,
      'ratelimited',
      retryAfter,
    );
  }

  const slackError = err.data?.error;
  if (slackError !== undefined) {
    const details = err.data?.response_metadata?.messages;
    const suffix = details && details.length > 0 ? ` (${details.join('; ')})` : '';
    return new SlackApiError(`Slack API error: ${slackError}${suffix}`, slackError);
  }

  const message = err.message ?? 'Unknown Slack API error.';
  return new SlackApiError(message);
}
