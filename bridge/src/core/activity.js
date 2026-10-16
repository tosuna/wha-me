export function isOwnerActive(lastManualFromMeAt, now, windowMs = 30 * 60 * 1000) {
  if (lastManualFromMeAt == null) return false;
  return Number(now) - Number(lastManualFromMeAt) < windowMs;
}
