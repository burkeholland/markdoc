export const PRESSURE_GAUGE_NAMES = [
  "pg_total",
  "pg_idle",
  "pg_waiting",
  "pg_checkout_max_ms",
  "collab_connections",
  "render_queue",
  "render_inflight",
  "pdf_queue",
  "pdf_inflight",
  "long_polls",
  "webhook_inflight",
  "webhook_retries",
] as const;

export type PressureGaugeName = (typeof PRESSURE_GAUGE_NAMES)[number];
export type PressureGaugeSnapshot = Record<PressureGaugeName, number>;
export type PressureGaugeProvider = (resetIntervalMaximum: boolean) => number;

interface PressureGaugeRegistry {
  providers: Map<PressureGaugeName, PressureGaugeProvider>;
}

const g = globalThis as typeof globalThis & { __markdocPressureGauges?: PressureGaugeRegistry };
const registry: PressureGaugeRegistry = (g.__markdocPressureGauges ??= { providers: new Map() });

/**
 * Register a fixed-name, integer process gauge. The disposer only removes its own provider, so a
 * replacement module loaded during development cannot be unregistered by the superseded module.
 */
export function registerPressureGauge(name: PressureGaugeName, provider: PressureGaugeProvider): () => void {
  registry.providers.set(name, provider);
  return () => {
    if (registry.providers.get(name) === provider) registry.providers.delete(name);
  };
}

export interface PressureGaugeCollection {
  gauges: PressureGaugeSnapshot;
  failures: number;
}

function integerGauge(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Number.MAX_SAFE_INTEGER, Math.round(value));
}

/** Read every fixed gauge. A broken provider is surfaced as `failures` and cannot stop the server. */
export function collectPressureGauges(resetIntervalMaximum = true): PressureGaugeCollection {
  const gauges: PressureGaugeSnapshot = {
    pg_total: 0,
    pg_idle: 0,
    pg_waiting: 0,
    pg_checkout_max_ms: 0,
    collab_connections: 0,
    render_queue: 0,
    render_inflight: 0,
    pdf_queue: 0,
    pdf_inflight: 0,
    long_polls: 0,
    webhook_inflight: 0,
    webhook_retries: 0,
  };
  let failures = 0;
  for (const name of PRESSURE_GAUGE_NAMES) {
    const provider = registry.providers.get(name);
    if (!provider) continue;
    try {
      gauges[name] = integerGauge(provider(resetIntervalMaximum));
    } catch {
      failures++;
    }
  }
  return { gauges, failures };
}
