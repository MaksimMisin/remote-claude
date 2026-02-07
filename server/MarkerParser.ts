// ============================================================
// MarkerParser -- Parse <!--rc:CATEGORY:MESSAGE--> markers
// ============================================================

import type { MarkerCategory, RcMarker } from '../shared/types.js';

const VALID_CATEGORIES = new Set<MarkerCategory>([
  'notification', 'summary', 'question', 'progress',
  'error', 'finished', 'silent',
]);

const RC_MARKER_RE = /<!--rc:(\w+):(.*?)-->/s;
const RC_MARKER_ESCAPED_RE = /<\\!--rc:(\w+):(.*?)-->/s;
const RC_SILENT_RE = /<!--rc:silent-->/;
const RC_SILENT_ESCAPED_RE = /<\\!--rc:silent-->/;

export function parseMarker(text: string): RcMarker | null {
  if (RC_SILENT_RE.test(text) || RC_SILENT_ESCAPED_RE.test(text)) {
    return { category: 'silent', message: '' };
  }

  let match = text.match(RC_MARKER_RE);
  if (!match) match = text.match(RC_MARKER_ESCAPED_RE);
  if (!match) return null;

  const category = match[1] as MarkerCategory;
  const message = match[2].trim();

  if (!VALID_CATEGORIES.has(category)) return null;

  return { category, message };
}
