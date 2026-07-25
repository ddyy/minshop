// Stub for the `cloudflare:workers` module under vitest.
//
// Pure-function tests run in plain Node with no Workers runtime, but modules
// like config.ts import `env` at the top level purely to read deployment vars.
// An empty env is exactly right here: it makes those modules fall back to their
// declared defaults, which is what a unit test wants to assert against.
// Anything that needs a REAL binding (D1/R2) still belongs in the integration
// scripts, not here.
export const env = {} as Record<string, unknown>;
