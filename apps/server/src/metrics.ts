import { createHash, timingSafeEqual } from "node:crypto";
import { monitorEventLoopDelay } from "node:perf_hooks";
import type { Db } from "@sling/db";
import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { DELIVERY_KINDS } from "./deliveries.ts";
import { within } from "./lifecycle.ts";

/** Upper bounds, in seconds, of the request duration buckets. */
const DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30];
/** How often the event loop is sampled. Every sample includes this interval. */
const LOOP_RESOLUTION_MS = 10;
/** A scrape never waits longer than this on the database. */
const DATABASE_BUDGET_MS = 2_000;

type Labels = Record<string, string>;

interface RequestSeries {
  labels: Labels;
  /** Per bucket, not cumulative. The last entry counts requests above every bound. */
  counts: number[];
  sum: number;
  count: number;
}

export interface JobQueueStats {
  queue: string;
  /** Due jobs no worker has picked up yet. */
  waiting: number;
  /** Jobs scheduled for later. */
  deferred: number;
  active: number;
  /** How long the oldest due job has waited past its start time. */
  lagSeconds: number;
  /** How long ago the oldest waiting job was created, counting its retries. */
  ageSeconds: number;
}

export interface DeliveryStats {
  kind: string;
  pending: number;
  /** Pending deliveries that have failed at least once and are waiting to retry. */
  failing: number;
  lagSeconds: number;
}

export interface DatabaseStats {
  jobs: JobQueueStats[];
  deliveries: DeliveryStats[];
  runnersRegistered: number;
}

/** What a scrape reads besides this process's own counters. */
export interface MetricSources {
  runnersConnected(): number;
  automationPaused?: boolean;
  database(): Promise<DatabaseStats>;
  onDatabaseError?(err: unknown): void;
}

/**
 * Operational metrics in the Prometheus text format. Request and delivery counters live in
 * this process and restart from zero with it; queue and delivery backlogs are read from the
 * database on each scrape.
 */
export class Metrics {
  readonly #requests = new Map<string, RequestSeries>();
  readonly #deliveryFailures = new Map<string, number>();
  readonly #loop = monitorEventLoopDelay({ resolution: LOOP_RESOLUTION_MS });

  constructor() {
    this.#loop.enable();
  }

  stop() {
    this.#loop.disable();
  }

  /** Times every response by its route pattern, never the raw URL, which can carry IDs and tokens. */
  observe(app: FastifyInstance) {
    app.addHook("onResponse", (request, reply, done) => {
      this.request(
        request.method,
        request.routeOptions.url ?? "unmatched",
        reply.statusCode,
        reply.elapsedTime / 1000,
      );
      done();
    });
  }

  request(method: string, route: string, status: number, seconds: number) {
    const key = `${method} ${status} ${route}`;
    let series = this.#requests.get(key);
    if (!series) {
      series = {
        labels: { method, route, status: String(status) },
        counts: new Array(DURATION_BUCKETS.length + 1).fill(0),
        sum: 0,
        count: 0,
      };
      this.#requests.set(key, series);
    }
    const bucket = DURATION_BUCKETS.findIndex((bound) => seconds <= bound);
    const index = bucket === -1 ? DURATION_BUCKETS.length : bucket;
    series.counts[index] = (series.counts[index] ?? 0) + 1;
    series.sum += seconds;
    series.count += 1;
  }

  deliveryFailed(kind: string) {
    this.#deliveryFailures.set(kind, (this.#deliveryFailures.get(kind) ?? 0) + 1);
  }

  async render(sources: MetricSources): Promise<string> {
    const out = new Exposition();
    out.histogram(
      "sling_http_request_duration_seconds",
      "Time to answer HTTP requests, by method, route pattern, and status.",
      DURATION_BUCKETS,
      [...this.#requests.values()],
    );
    out.metric(
      "sling_delivery_failures_total",
      "counter",
      "Failed delivery attempts since this process started, by kind.",
      [...this.#deliveryFailures].map(([kind, n]) => [{ kind }, n]),
    );
    out.metric(
      "sling_runners_connected",
      "gauge",
      "Runners connected to this control plane. Not part of readiness.",
      [[{}, sources.runnersConnected()]],
    );
    out.metric(
      "sling_automation_paused",
      "gauge",
      "1 while SLING_AUTOMATION_PAUSED holds back runs, deliveries, sources, schedules, webhooks, and push.",
      [[{}, sources.automationPaused ? 1 : 0]],
    );
    this.#renderLoop(out);
    const memory = process.memoryUsage();
    out.metric("sling_process_resident_memory_bytes", "gauge", "Resident set size.", [
      [{}, memory.rss],
    ]);
    out.metric("sling_process_heap_used_bytes", "gauge", "V8 heap in use.", [
      [{}, memory.heapUsed],
    ]);

    let stats: DatabaseStats | undefined;
    try {
      stats = await within(sources.database(), DATABASE_BUDGET_MS, "Metrics query timed out");
    } catch (err) {
      sources.onDatabaseError?.(err);
    }
    out.metric(
      "sling_scrape_collector_success",
      "gauge",
      "Whether a part of this scrape could be read. The database part fails while Postgres is unavailable.",
      [[{ collector: "database" }, stats ? 1 : 0]],
    );
    if (stats) renderDatabase(out, stats);
    return out.toString();
  }

  #renderLoop(out: Exposition) {
    const h = this.#loop;
    const empty = h.count === 0;
    const delay = (ns: number) => (empty ? 0 : Math.max(0, ns / 1e6 - LOOP_RESOLUTION_MS) / 1000);
    const help = "Event loop delay since the previous scrape";
    out.metric("sling_event_loop_delay_p50_seconds", "gauge", `${help}, median.`, [
      [{}, delay(h.percentile(50))],
    ]);
    out.metric("sling_event_loop_delay_p99_seconds", "gauge", `${help}, 99th percentile.`, [
      [{}, delay(h.percentile(99))],
    ]);
    out.metric("sling_event_loop_delay_max_seconds", "gauge", `${help}, maximum.`, [
      [{}, delay(h.max)],
    ]);
    h.reset();
  }
}

function renderDatabase(out: Exposition, stats: DatabaseStats) {
  out.metric(
    "sling_job_queue_jobs",
    "gauge",
    "Background jobs by queue and state: waiting (due), deferred (scheduled for later), active.",
    stats.jobs.flatMap((q) => [
      [{ queue: q.queue, state: "waiting" }, q.waiting] as const,
      [{ queue: q.queue, state: "deferred" }, q.deferred] as const,
      [{ queue: q.queue, state: "active" }, q.active] as const,
    ]),
  );
  out.metric(
    "sling_job_queue_lag_seconds",
    "gauge",
    "How long the oldest due job in each queue has waited for a worker.",
    stats.jobs.map((q) => [{ queue: q.queue }, q.lagSeconds]),
  );
  out.metric(
    "sling_job_queue_age_seconds",
    "gauge",
    "Age of the oldest waiting job in each queue, including time spent between retries.",
    stats.jobs.map((q) => [{ queue: q.queue }, q.ageSeconds]),
  );
  out.metric(
    "sling_deliveries_pending",
    "gauge",
    "Deliveries not yet completed, by kind.",
    stats.deliveries.map((d) => [{ kind: d.kind }, d.pending]),
  );
  out.metric(
    "sling_deliveries_failing",
    "gauge",
    "Pending deliveries that have failed at least once and will retry, by kind.",
    stats.deliveries.map((d) => [{ kind: d.kind }, d.failing]),
  );
  out.metric(
    "sling_delivery_lag_seconds",
    "gauge",
    "How long the oldest due delivery of each kind has waited.",
    stats.deliveries.map((d) => [{ kind: d.kind }, d.lagSeconds]),
  );
  out.metric("sling_runners_registered", "gauge", "Paired runners that aren't revoked.", [
    [{}, stats.runnersRegistered],
  ]);
}

/** Queue and delivery backlogs. Bounded by a statement timeout, and read only. */
export async function databaseStats(db: Db): Promise<DatabaseStats> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set transaction read only`);
    await tx.execute(sql.raw(`set local statement_timeout = ${DATABASE_BUDGET_MS}`));
    const jobs = await tx.execute<{
      queue: string;
      waiting: number;
      deferred: number;
      active: number;
      lag: number;
      age: number;
    }>(sql`
      select q.name as queue,
        count(j.id) filter (where j.state < 'active' and j.start_after <= now())::int as waiting,
        count(j.id) filter (where j.state < 'active' and j.start_after > now())::int as deferred,
        count(j.id) filter (where j.state = 'active')::int as active,
        coalesce(extract(epoch from now() - min(j.start_after)
          filter (where j.state < 'active' and j.start_after <= now())), 0)::float8 as lag,
        coalesce(extract(epoch from now() - min(j.created_on)
          filter (where j.state < 'active' and (j.start_after <= now() or j.state = 'retry'))), 0)::float8 as age
      from pgboss.queue q
      left join pgboss.job j on j.name = q.name and j.state <= 'active'
      group by q.name
      order by q.name`);
    const deliveries = await tx.execute<{
      kind: string;
      pending: number;
      failing: number;
      lag: number;
    }>(sql`
      select kind,
        count(*)::int as pending,
        count(*) filter (where attempts > 0)::int as failing,
        coalesce(extract(epoch from now() - min(available_at)
          filter (where available_at <= now())), 0)::float8 as lag
      from deliveries
      where completed_at is null
      group by kind`);
    const runners = await tx.execute<{ n: number }>(
      sql`select count(*)::int as n from runners where revoked_at is null`,
    );
    const byKind = new Map(deliveries.rows.map((d) => [d.kind, d]));
    return {
      jobs: jobs.rows.map((r) => ({
        queue: r.queue,
        waiting: r.waiting,
        deferred: r.deferred,
        active: r.active,
        lagSeconds: r.lag,
        ageSeconds: r.age,
      })),
      // Known kinds report zero rather than disappearing, so alerts see a value.
      deliveries: [...new Set([...DELIVERY_KINDS, ...byKind.keys()])].sort().map((kind) => {
        const d = byKind.get(kind);
        return {
          kind,
          pending: d?.pending ?? 0,
          failing: d?.failing ?? 0,
          lagSeconds: d?.lag ?? 0,
        };
      }),
      runnersRegistered: runners.rows[0]?.n ?? 0,
    };
  });
}

/** Compares a request's Authorization header with the configured token in constant time. */
export function bearerMatches(header: string | undefined, token: string): boolean {
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(header ?? ""), digest(`Bearer ${token}`));
}

class Exposition {
  readonly #lines: string[] = [];

  metric(
    name: string,
    type: "counter" | "gauge",
    help: string,
    samples: ReadonlyArray<readonly [Labels, number]>,
  ) {
    this.#head(name, type, help);
    for (const [labels, value] of samples) this.#lines.push(`${name}${text(labels)} ${num(value)}`);
  }

  histogram(name: string, help: string, bounds: number[], series: RequestSeries[]) {
    this.#head(name, "histogram", help);
    for (const s of series) {
      let cumulative = 0;
      bounds.forEach((bound, i) => {
        cumulative += s.counts[i] ?? 0;
        this.#lines.push(`${name}_bucket${text({ ...s.labels, le: String(bound) })} ${cumulative}`);
      });
      this.#lines.push(`${name}_bucket${text({ ...s.labels, le: "+Inf" })} ${s.count}`);
      this.#lines.push(`${name}_sum${text(s.labels)} ${num(s.sum)}`);
      this.#lines.push(`${name}_count${text(s.labels)} ${s.count}`);
    }
  }

  #head(name: string, type: string, help: string) {
    this.#lines.push(`# HELP ${name} ${help.replace(/\\/g, "\\\\").replace(/\n/g, "\\n")}`);
    this.#lines.push(`# TYPE ${name} ${type}`);
  }

  toString() {
    return `${this.#lines.join("\n")}\n`;
  }
}

function text(labels: Labels): string {
  const parts = Object.entries(labels).map(
    ([key, value]) =>
      `${key}="${value.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/"/g, '\\"')}"`,
  );
  return parts.length > 0 ? `{${parts.join(",")}}` : "";
}

function num(value: number): string {
  if (Number.isNaN(value)) return "NaN";
  if (value === Number.POSITIVE_INFINITY) return "+Inf";
  if (value === Number.NEGATIVE_INFINITY) return "-Inf";
  return String(value);
}
