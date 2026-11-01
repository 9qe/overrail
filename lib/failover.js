const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504, 529]);

async function withFailover(chain, attempt_fn) {
  const attempts = [];
  for (const profile_name of chain) {
    let result;
    try {
      result = await attempt_fn(profile_name);
    } catch (err) {
      attempts.push({ profile: profile_name, error: err && err.message ? err.message : String(err) });
      continue;
    }
    if (result && result.ok) return result;
    const status = result && typeof result.status === "number" ? result.status : 0;
    attempts.push({ profile: profile_name, error: `http ${status}` });
    if (!RETRYABLE_STATUSES.has(status)) {
      const err = new Error(`provider "${profile_name}" failed with non-retryable status ${status}`);
      err.attempts = attempts;
      throw err;
    }
  }
  const err = new Error("all providers failed");
  err.attempts = attempts;
  throw err;
}

module.exports = { withFailover };
