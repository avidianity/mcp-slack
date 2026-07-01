/**
 * Shapers convert noisy raw Slack objects into flat, uniform records so TOON's
 * tabular layout applies (a header plus rows) instead of deeply nested blobs.
 *
 * Input types are intentionally minimal structural interfaces describing only
 * the fields we read, keeping this layer decoupled from `@slack/web-api`'s large
 * response typings. Output fields are `T | undefined`; both JSON and TOON omit
 * undefined values on encode.
 */

interface RawChannel {
  id?: string;
  name?: string;
  is_private?: boolean;
  is_archived?: boolean;
  is_member?: boolean;
  num_members?: number;
  topic?: { value?: string };
  purpose?: { value?: string };
}

export interface ShapedChannel {
  id: string | undefined;
  name: string | undefined;
  is_private: boolean | undefined;
  is_archived: boolean | undefined;
  is_member: boolean | undefined;
  num_members: number | undefined;
  topic: string | undefined;
  purpose: string | undefined;
}

export function shapeChannel(channel: RawChannel): ShapedChannel {
  return {
    id: channel.id,
    name: channel.name,
    is_private: channel.is_private,
    is_archived: channel.is_archived,
    is_member: channel.is_member,
    num_members: channel.num_members,
    topic: channel.topic?.value,
    purpose: channel.purpose?.value,
  };
}

interface RawReaction {
  name?: string;
  count?: number;
}

interface RawMessage {
  type?: string;
  user?: string;
  bot_id?: string;
  text?: string;
  ts?: string;
  thread_ts?: string;
  reply_count?: number;
  reactions?: RawReaction[];
  edited?: { user?: string; ts?: string };
}

export interface ShapedMessage {
  ts: string | undefined;
  user: string | undefined;
  bot_id: string | undefined;
  text: string | undefined;
  thread_ts: string | undefined;
  reply_count: number | undefined;
  reactions: string | undefined;
  edited: boolean;
}

/** Flatten reactions to a compact `name:count` list for a single column. */
function flattenReactions(reactions: RawReaction[] | undefined): string | undefined {
  if (reactions === undefined || reactions.length === 0) {
    return undefined;
  }
  return reactions.map((r) => `${r.name ?? '?'}:${r.count ?? 0}`).join(' ');
}

export function shapeMessage(message: RawMessage): ShapedMessage {
  return {
    ts: message.ts,
    user: message.user,
    bot_id: message.bot_id,
    text: message.text,
    thread_ts: message.thread_ts,
    reply_count: message.reply_count,
    reactions: flattenReactions(message.reactions),
    edited: message.edited !== undefined,
  };
}

interface RawUserProfile {
  real_name?: string;
  display_name?: string;
  title?: string;
  email?: string;
  phone?: string;
  status_text?: string;
}

interface RawUser {
  id?: string;
  name?: string;
  real_name?: string;
  deleted?: boolean;
  is_bot?: boolean;
  is_admin?: boolean;
  tz?: string;
  profile?: RawUserProfile;
}

export interface ShapedUser {
  id: string | undefined;
  name: string | undefined;
  real_name: string | undefined;
  display_name: string | undefined;
  title: string | undefined;
  email: string | undefined;
  is_bot: boolean | undefined;
  is_admin: boolean | undefined;
  deleted: boolean | undefined;
  tz: string | undefined;
}

export function shapeUser(user: RawUser): ShapedUser {
  return {
    id: user.id,
    name: user.name,
    real_name: user.real_name ?? user.profile?.real_name,
    display_name: user.profile?.display_name,
    title: user.profile?.title,
    email: user.profile?.email,
    is_bot: user.is_bot,
    is_admin: user.is_admin,
    deleted: user.deleted,
    tz: user.tz,
  };
}

interface RawFile {
  id?: string;
  name?: string;
  title?: string;
  mimetype?: string;
  size?: number;
  permalink?: string;
  url_private?: string;
}

export interface ShapedFile {
  id: string | undefined;
  name: string | undefined;
  title: string | undefined;
  mimetype: string | undefined;
  size: number | undefined;
  permalink: string | undefined;
}

export function shapeFile(file: RawFile): ShapedFile {
  return {
    id: file.id,
    name: file.name,
    title: file.title,
    mimetype: file.mimetype,
    size: file.size,
    permalink: file.permalink ?? file.url_private,
  };
}
