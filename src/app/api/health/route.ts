import { NextResponse } from 'next/server';

// Benchmark baseline AND load-balancer liveness probe:
// no DB, no Redis, no external calls, so it measures only Node + Next.js.
// force-dynamic prevents Next from serving this as a static file, which would
// make both the benchmark numbers and the health signal meaningless.
export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json({
    status: 'ok',
    instance: process.env.INSTANCE_ID ?? `pid-${process.pid}`,
    port: process.env.PORT ?? 'unknown',
    uptimeSeconds: Math.round(process.uptime()),
    ts: Date.now(),
  });
}
