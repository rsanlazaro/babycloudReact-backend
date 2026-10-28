// backend/services/concurrency.js
// Protects against "lost updates" when two people edit the same register at
// the same time: the frontend sends only the fields it changed, plus the
// values it ORIGINALLY loaded for them (`_original`). Before writing, the
// backend checks those fields still hold the original values. If someone else
// changed one meanwhile, the save is refused (409) instead of overwriting.

/** Comparable text form of a DB/UI value: null/''→'', Date/ISO→YYYY-MM-DD, true→'1', '65.00'→'65' */
export const normValue = (v) => {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return '';
    return `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, '0')}-${String(v.getDate()).padStart(2, '0')}`;
  }
  if (typeof v === 'boolean') return v ? '1' : '0';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (Buffer.isBuffer(v)) return v.length ? String(v[0]) : '';
  if (typeof v === 'object') { try { return JSON.stringify(v); } catch { return String(v); } }
  const s = String(v).trim();
  if (s === '') return '';
  if (/^\d{4}-\d{2}-\d{2}T/.test(s)) return s.slice(0, 10);
  if (s === 'true') return '1';
  if (s === 'false') return '0';
  if (/^-?\d+(\.\d+)?$/.test(s)) return String(Number(s));
  return s;
};

/**
 * Fields whose current value differs from what the client originally loaded
 * AND from what it now wants to write (writing the same value is harmless).
 * current/original/next: plain objects keyed by field name.
 */
export const findConflicts = (current, original, next, skip = []) =>
  Object.keys(original || {}).filter(k => {
    if (skip.includes(k)) return false;
    const cur = normValue(current?.[k]);
    return cur !== normValue(original[k]) && cur !== normValue(next?.[k]);
  });

export const conflictResponse = (res, fields, current) =>
  res.status(409).json({
    code: 'CONFLICT',
    message: 'Otro usuario modificó este registro mientras lo editabas. Se recargaron los datos actuales; revisa y vuelve a guardar.',
    fields,
    current,
  });