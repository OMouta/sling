import { afterEach, expect, it } from "vitest";
import { bearerMatches, type DatabaseStats, Metrics } from "./metrics.ts";

const stats: DatabaseStats = {
  jobs: [
    {
      queue: "workflow-run",
      waiting: 3,
      deferred: 1,
      active: 2,
      lagSeconds: 12.5,
      ageSeconds: 40,
    },
  ],
  deliveries: [{ kind: "settle.push", pending: 2, failing: 1, lagSeconds: 3 }],
  runnersRegistered: 4,
};

let metrics: Metrics | undefined;
afterEach(() => metrics?.stop());

it("renders cumulative request histograms by route pattern", async () => {
  metrics = new Metrics();
  metrics.request("GET", "/api/tasks/:id", 200, 0.004);
  metrics.request("GET", "/api/tasks/:id", 200, 0.3);
  metrics.request("GET", "/api/tasks/:id", 200, 45);
  const text = await metrics.render({
    runnersConnected: () => 0,
    database: async () => stats,
  });
  const labels = 'method="GET",route="/api/tasks/:id",status="200"';
  expect(text).toContain("# TYPE sling_http_request_duration_seconds histogram");
  expect(text).toContain(`sling_http_request_duration_seconds_bucket{${labels},le="0.005"} 1`);
  expect(text).toContain(`sling_http_request_duration_seconds_bucket{${labels},le="0.25"} 1`);
  expect(text).toContain(`sling_http_request_duration_seconds_bucket{${labels},le="0.5"} 2`);
  expect(text).toContain(`sling_http_request_duration_seconds_bucket{${labels},le="30"} 2`);
  expect(text).toContain(`sling_http_request_duration_seconds_bucket{${labels},le="+Inf"} 3`);
  expect(text).toContain(`sling_http_request_duration_seconds_count{${labels}} 3`);
  expect(text).toMatch(/sling_http_request_duration_seconds_sum\{[^}]+\} 45\.30/);
});

it("reports queues, deliveries, and runners from the database and the process", async () => {
  metrics = new Metrics();
  metrics.deliveryFailed("settle.push");
  metrics.deliveryFailed("settle.push");
  const text = await metrics.render({ runnersConnected: () => 1, database: async () => stats });
  expect(text).toContain('sling_job_queue_jobs{queue="workflow-run",state="waiting"} 3');
  expect(text).toContain('sling_job_queue_jobs{queue="workflow-run",state="deferred"} 1');
  expect(text).toContain('sling_job_queue_lag_seconds{queue="workflow-run"} 12.5');
  expect(text).toContain('sling_job_queue_age_seconds{queue="workflow-run"} 40');
  expect(text).toContain('sling_delivery_failures_total{kind="settle.push"} 2');
  expect(text).toContain('sling_deliveries_failing{kind="settle.push"} 1');
  expect(text).toContain("sling_runners_connected 1");
  expect(text).toContain("sling_runners_registered 4");
  expect(text).toContain('sling_scrape_collector_success{collector="database"} 1');
  expect(text).toMatch(/^sling_event_loop_delay_p99_seconds \d/m);
  expect(text.endsWith("\n")).toBe(true);
});

it("still answers when the database can't be read", async () => {
  metrics = new Metrics();
  const errors: unknown[] = [];
  const text = await metrics.render({
    runnersConnected: () => 0,
    database: () => Promise.reject(new Error("connection refused")),
    onDatabaseError: (err) => errors.push(err),
  });
  expect(errors).toHaveLength(1);
  expect(text).toContain('sling_scrape_collector_success{collector="database"} 0');
  expect(text).toContain("sling_runners_connected 0");
  expect(text).not.toContain("sling_job_queue_lag_seconds{");
});

it("escapes label values", async () => {
  metrics = new Metrics();
  metrics.request("GET", 'a"b\\c\nd', 404, 0.001);
  const text = await metrics.render({ runnersConnected: () => 0, database: async () => stats });
  expect(text).toContain('route="a\\"b\\\\c\\nd"');
});

it("accepts only the configured bearer token", () => {
  const token = "t".repeat(40);
  expect(bearerMatches(`Bearer ${token}`, token)).toBe(true);
  expect(bearerMatches(`Bearer ${token}x`, token)).toBe(false);
  expect(bearerMatches(token, token)).toBe(false);
  expect(bearerMatches(undefined, token)).toBe(false);
});
