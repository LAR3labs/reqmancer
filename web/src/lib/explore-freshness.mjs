export function isOlderThanWindow(postedAt, sinceDays, now = Date.now()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(postedAt) || !Number.isFinite(sinceDays)) return false;
  const posted = Date.parse(`${postedAt}T00:00:00Z`);
  if (!Number.isFinite(posted)) return false;
  const today = new Date(now);
  const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return posted < todayUtc - Math.max(0, sinceDays) * 86_400_000;
}
