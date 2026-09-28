// backend/services/curp.js
// Shared CURP helpers — used to link payments_gest (Listado de pagos) with
// SORT_GES candidates (sort_ges_alta_gesca.curp).

/** Uppercase, strip spaces. Empty/invalid input → '' */
export const normalizeCurp = (value) =>
  typeof value === 'string' ? value.replace(/\s+/g, '').toUpperCase() : '';

/**
 * CURP rule: letters and digits only, between CURP_MIN_LENGTH and
 * CURP_MAX_LENGTH characters. Length varies in practice (e.g. 16-char codes),
 * so the strict 18-char official layout is NOT enforced.
 * Max 18 = size of the payments_gest.curp column. Keep in sync with the
 * frontend (SortGes.js, PaymentsGestForm.js).
 */
export const CURP_MIN_LENGTH = 10;
export const CURP_MAX_LENGTH = 18;
export const CURP_REGEX = new RegExp(`^[A-Z0-9]{${CURP_MIN_LENGTH},${CURP_MAX_LENGTH}}$`);
export const CURP_FORMAT_MESSAGE =
  `La CURP debe tener entre ${CURP_MIN_LENGTH} y ${CURP_MAX_LENGTH} letras o números`;

export const isValidCurp = (value) => CURP_REGEX.test(normalizeCurp(value));

/** "$400,000.00" | "400000" | 400000 → 400000 (number) or null */
export const parseSchemeAmount = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const n = Math.round(parseFloat(String(value).replace(/[^0-9.]/g, '')));
  return Number.isFinite(n) ? n : null;
};

/** Scheme values the payments form knows how to calculate */
export const VALID_SCHEMES = [375000, 400000, 450000, 475000];