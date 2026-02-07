/**
 * Returns a human-readable relative time string.
 * Examples: "now", "5s ago", "3m ago", "2h ago", "1d ago"
 */
export function relativeTime(ts: number): string {
  if (!ts) return '';
  const d = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (d < 5) return 'now';
  if (d < 60) return d + 's ago';
  if (d < 3600) return Math.floor(d / 60) + 'm ago';
  if (d < 86400) return Math.floor(d / 3600) + 'h ago';
  return Math.floor(d / 86400) + 'd ago';
}

/**
 * Formats a timestamp as HH:MM:SS.
 */
export function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toTimeString().slice(0, 8);
}

/**
 * Format token count for display: 0, 1.2k, 45k, 1.2M
 */
export function formatTokens(n: number | undefined): string {
  if (n == null || n === 0) return '0';
  if (n < 1000) return String(n);
  if (n < 100_000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  if (n < 1_000_000) return Math.round(n / 1000) + 'k';
  return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
}
