/** Advertised client metadata only; does not resize or truncate upstream requests. */
function normalizeComboTokenLimit(value, field) {
  if (value == null || value === 0 || (typeof value === 'string' && value.trim() === '')) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    const error = new Error(`${field} must be a positive safe integer token count, or null for Auto`);
    error.status = 400;
    throw error;
  }
  return value;
}

export function normalizeComboContextLength(value) {
  return normalizeComboTokenLimit(value, 'contextLength');
}

export function normalizeComboMaxOutputTokens(value) {
  return normalizeComboTokenLimit(value, 'maxOutputTokens');
}
