import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Bench-only settings. These do not affect the regular `npm test` run
    // because `bench` and `run` modes read the same config but only `bench`
    // consumes the `bench` field.
    bench: {
      // Give tinybench a longer per-task window so the percentile estimates
      // stabilise. The default 500ms produces visible run-to-run jitter on the
      // sub-microsecond SubscriptionManager benches.
      time: 1000,
      // Warm up V8's inline caches before the measured window. Without an
      // explicit warmup the first iteration of each task biases p99.
      warmupIterations: 100,
      iterations: 500,
      include: ["tests/**/*.bench.ts"],
    },
  },
});
