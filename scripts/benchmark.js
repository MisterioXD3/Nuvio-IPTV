'use strict';

/**
 * Hits the addon endpoints repeatedly and reports latency percentiles.
 * Usage: node scripts/benchmark.js <baseUrl> <catalogId> [requests]
 */
const [, , baseUrl = 'http://127.0.0.1:7010', catalogId, requestCount = '500'] = process.argv;

if (!catalogId) {
  console.error('Uso: node scripts/benchmark.js <baseUrl> <catalogId> [requests]');
  process.exit(1);
}

const percentile = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];

const run = async () => {
  const total = Number(requestCount);
  const durations = [];
  for (let i = 0; i < total; i += 1) {
    const skip = (i % 20) * 100;
    const started = process.hrtime.bigint();
    const response = await fetch(`${baseUrl}/catalog/tv/${catalogId}/skip=${skip}.json`);
    await response.arrayBuffer();
    durations.push(Number(process.hrtime.bigint() - started) / 1e6);
  }
  durations.sort((a, b) => a - b);
  console.log({
    requests: total,
    p50: `${percentile(durations, 50).toFixed(2)} ms`,
    p95: `${percentile(durations, 95).toFixed(2)} ms`,
    p99: `${percentile(durations, 99).toFixed(2)} ms`,
    max: `${durations[durations.length - 1].toFixed(2)} ms`,
  });
};

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
