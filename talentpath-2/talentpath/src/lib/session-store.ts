import Redis from 'ioredis';
import { cookies } from 'next/headers';
import { createHash } from 'crypto';

/**
 * Shared session/token state for the 3-instance nginx load balancer setup.
 *
 * WHY THIS EXISTS
 * ---------------
 * Your auth uses NextAuth v5 with `strategy: 'jwt'`, so the session lives in a
 * signed cookie, not on the server. That is STATELESS — all three instances can
 * already validate it, because they share AUTH_SECRET. Round robin does not
 * break login on its own.
 *
 * What a stateless JWT genuinely CANNOT do, and what this module adds:
 *
 *   1. Revocation. A JWT is valid until it expires. "Log out everywhere" and
 *      "ban this user now" are impossible without a server-side record.
 *   2. Shared visibility. Which instances has this user hit? How many active
 *      sessions? In-memory state would give three separate, wrong answers.
 *   3. A shared counter/limiter. Three instances each with a local rate limit
 *      of 100 means the real limit is 300.
 *
 * Redis is the single source of truth all three instances read and write.
 *
 * NOTE: this module is purely ADDITIVE. It does not modify src/lib/auth.ts.
 * The session id is derived by hashing the auth cookie, so it is stable for
 * the life of a login without needing a `jti` claim added to the JWT.
 */

const globalForRedis = global as unknown as { lbRedis?: Redis };

/**
 * Resolve a connection string, preferring Upstash over local Redis.
 *
 * Upstash publishes an HTTPS REST endpoint, but ioredis speaks the Redis wire
 * protocol over TCP — you cannot hand it the https:// URL directly. Strip the
 * scheme and rebuild it as a TLS Redis URL on port 6379. This is the same
 * transformation src/lib/redis-connection.ts already performs.
 *
 * Order: Upstash credentials -> REDIS_URL -> localhost.
 * To use local Redis instead, comment out the UPSTASH_* vars in .env.
 */
function resolveRedisUrl(): string {
  const restUrl =
    process.env.UPSTASH_REDIS_REST_URL1 || process.env.UPSTASH_REDIS_REST_URL;
  const restToken =
    process.env.UPSTASH_REDIS_REST_TOKEN1 || process.env.UPSTASH_REDIS_REST_TOKEN;

  if (restUrl && restToken) {
    const host = restUrl.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
    return `rediss://default:${restToken}@${host}:6379`;
  }

  return process.env.REDIS_URL || 'redis://127.0.0.1:6379';
}

export const redis =
  globalForRedis.lbRedis ??
  new Redis(resolveRedisUrl(), {
    maxRetriesPerRequest: 2,
    // Never let a Redis hiccup take the whole page down.
    retryStrategy: (times) => Math.min(times * 200, 2000),
  });

// ioredis emits 'error' on every failed reconnect. With no listener attached
// Node treats it as an unhandled error event and kills the process, so a
// stopped Redis would take the whole instance down instead of degrading.
redis.on('error', (err: Error) => {
  console.error('[session-store] redis unavailable:', err.message);
});

if (process.env.NODE_ENV !== 'production') globalForRedis.lbRedis = redis;

/** Set per instance in the start command, e.g. INSTANCE_ID=instance-2. */
export const INSTANCE_ID = process.env.INSTANCE_ID ?? `pid-${process.pid}`;

const SESSION_TTL = 60 * 60 * 24 * 30; // 30 days, matching auth.ts maxAge

const sessionKey = (sid: string) => `sess:${sid}`;
const userIndexKey = (userId: string) => `user-sessions:${userId}`;

export type SessionRecord = {
  sid: string;
  userId: string;
  email?: string;
  role?: string;
  createdAt: number;
  lastSeenAt: number;
  lastSeenOn: string;
  hits: number;
};

/**
 * Stable per-login id derived from the auth cookie.
 *
 * Covers both Auth.js v5 cookie names (`authjs.*`) and the legacy v4 names
 * (`next-auth.*`). Worth knowing: src/middleware.ts currently hardcodes the v4
 * name `next-auth.session-token`, which on v5 is why getToken() can come back
 * null there.
 */
export async function currentSid(): Promise<string | null> {
  const jar = await cookies();
  const raw =
    jar.get('authjs.session-token')?.value ??
    jar.get('__Secure-authjs.session-token')?.value ??
    jar.get('next-auth.session-token')?.value ??
    jar.get('__Secure-next-auth.session-token')?.value;

  if (!raw) return null;
  return createHash('sha256').update(raw).digest('hex').slice(0, 32);
}

/**
 * Record this request against the shared session. Called on every authenticated
 * request; whichever of the 3 instances handles it writes to the same Redis key,
 * so `lastSeenOn` shows round robin moving the user between backends while the
 * session itself stays intact.
 */
export async function touchSession(
  sid: string,
  user: { id: string; email?: string; role?: string },
): Promise<SessionRecord> {
  const key = sessionKey(sid);
  const now = Date.now();

  const existing = await redis.hgetall(key);
  const isNew = !existing || Object.keys(existing).length === 0;

  const record: SessionRecord = {
    sid,
    userId: user.id,
    email: user.email,
    role: user.role,
    createdAt: isNew ? now : Number(existing.createdAt),
    lastSeenAt: now,
    lastSeenOn: INSTANCE_ID,
    hits: isNew ? 1 : Number(existing.hits) + 1,
  };

  // One round trip for all writes instead of four.
  await redis
    .multi()
    .hset(key, {
      sid: record.sid,
      userId: record.userId,
      email: record.email ?? '',
      role: record.role ?? '',
      createdAt: String(record.createdAt),
      lastSeenAt: String(record.lastSeenAt),
      lastSeenOn: record.lastSeenOn,
      hits: String(record.hits),
    })
    .expire(key, SESSION_TTL)
    .sadd(userIndexKey(user.id), sid)
    .expire(userIndexKey(user.id), SESSION_TTL)
    .exec();

  return record;
}

export async function getSession(sid: string): Promise<SessionRecord | null> {
  const data = await redis.hgetall(sessionKey(sid));
  if (!data || Object.keys(data).length === 0) return null;

  return {
    sid: data.sid,
    userId: data.userId,
    email: data.email || undefined,
    role: data.role || undefined,
    createdAt: Number(data.createdAt),
    lastSeenAt: Number(data.lastSeenAt),
    lastSeenOn: data.lastSeenOn,
    hits: Number(data.hits),
  };
}

/** True once this session has been revoked — the thing a bare JWT cannot do. */
export async function isRevoked(sid: string): Promise<boolean> {
  return (await redis.exists(sessionKey(sid))) === 0;
}

export async function revokeSession(sid: string, userId?: string): Promise<void> {
  await redis.del(sessionKey(sid));
  if (userId) await redis.srem(userIndexKey(userId), sid);
}

/** Log out everywhere — takes effect on all 3 instances at once. */
export async function revokeAllForUser(userId: string): Promise<number> {
  const sids = await redis.smembers(userIndexKey(userId));
  if (sids.length === 0) return 0;

  await redis.del(...sids.map(sessionKey), userIndexKey(userId));
  return sids.length;
}

export async function listUserSessions(userId: string): Promise<SessionRecord[]> {
  const sids = await redis.smembers(userIndexKey(userId));
  const records = await Promise.all(sids.map(getSession));
  return records.filter((r): r is SessionRecord => r !== null);
}

/**
 * Shared rate limiter. Three instances with a local limit of N would allow 3N;
 * this counter lives in Redis so the limit is the limit.
 */
export async function rateLimit(
  identifier: string,
  limit: number,
  windowSeconds: number,
): Promise<{ allowed: boolean; remaining: number; resetIn: number }> {
  const key = `rl:${identifier}:${Math.floor(Date.now() / 1000 / windowSeconds)}`;

  const [[, count]] = (await redis
    .multi()
    .incr(key)
    .expire(key, windowSeconds)
    .exec()) as [[Error | null, number], ...unknown[]];

  return {
    allowed: count <= limit,
    remaining: Math.max(0, limit - count),
    resetIn: windowSeconds - (Math.floor(Date.now() / 1000) % windowSeconds),
  };
}

/** Per-instance counter, so you can verify nginx is splitting traffic evenly. */
export async function countRequest(): Promise<number> {
  return redis.hincrby('lb:instance-hits', INSTANCE_ID, 1);
}

export async function instanceHits(): Promise<Record<string, string>> {
  return redis.hgetall('lb:instance-hits');
}
