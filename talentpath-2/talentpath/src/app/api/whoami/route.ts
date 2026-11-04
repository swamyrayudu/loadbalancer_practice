import { NextResponse } from 'next/server';
import { auth } from '@/lib/auth';
import {
  INSTANCE_ID,
  currentSid,
  touchSession,
  countRequest,
  instanceHits,
} from '@/lib/session-store';

// Must never be cached, or you would see one instance's answer forever.
export const dynamic = 'force-dynamic';

/**
 * The demo endpoint for the load balancer lab.
 *
 * Hit http://localhost:8080/api/whoami repeatedly and watch:
 *   - `servedBy` rotate  instance-1 -> instance-2 -> instance-3   (round robin)
 *   - `session` stay IDENTICAL across all three                   (Redis works)
 *   - `distribution` stay roughly equal                           (even split)
 *
 * Kill one instance and hit it again: `servedBy` now only shows the surviving
 * two, and `session` is still intact. That is the whole system in one response.
 */
export async function GET() {
  const totalOnThisInstance = await countRequest();

  const authSession = await auth();
  const sid = await currentSid();

  let sharedSession = null;
  if (sid && authSession?.user) {
    const u = authSession.user as { id?: string; email?: string; role?: string };
    sharedSession = await touchSession(sid, {
      id: u.id ?? u.email ?? 'unknown',
      email: u.email,
      role: u.role,
    });
  }

  return NextResponse.json({
    servedBy: INSTANCE_ID,
    pid: process.pid,
    port: process.env.PORT ?? 'unknown',
    requestsHandledByThisInstance: totalOnThisInstance,

    // null when signed out — sign in through http://localhost:8080 to populate.
    loggedIn: Boolean(authSession?.user),
    session: sharedSession,

    // Read from Redis, so every instance reports the same totals.
    distribution: await instanceHits(),
  });
}
