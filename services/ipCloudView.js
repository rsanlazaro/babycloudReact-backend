// backend/services/ipCloudView.js
// "Vista en Baby Cloud" of an IP (Sort_IPS → Alta IP).
//
// Stored in the Alta IP data (sort_ip_sections, section 'alta') as
// `vista_babycloud`: false = the IP cannot open their register in Baby Cloud
// (/babycloud/cloud-ips/preview/:guestId); anything else = allowed. Registers
// saved before this option existed have no key, so they stay visible.
// No database change needed.

import pool from '../db.js';

export const CLOUD_VIEW_KEY = 'vista_babycloud';

const parseData = (v) => {
  if (!v) return {};
  if (typeof v === 'object') return v;
  try { return JSON.parse(v) || {}; } catch { return {}; }
};

/** true unless the Alta IP data says the view is disabled */
export const isCloudViewEnabled = (altaData) => parseData(altaData)[CLOUD_VIEW_KEY] !== false;

/**
 * View status of a Guests account.
 * @returns { linked: boolean, ipId: number|null, enabled: boolean }
 *   Accounts not linked to a Sort_IPS register are not controlled by this option.
 */
export const guestCloudView = async (guestId) => {
  const [rows] = await pool.query(
    `SELECT c.id, s.data
       FROM sort_ip_candidates c
       LEFT JOIN sort_ip_sections s ON s.candidate_id = c.id AND s.section = 'alta'
      WHERE c.guest_id = ?
      LIMIT 1`,
    [guestId]
  );
  if (!rows.length) return { linked: false, ipId: null, enabled: true };
  return { linked: true, ipId: rows[0].id, enabled: isCloudViewEnabled(rows[0].data) };
};

export const CLOUD_VIEW_DISABLED_MESSAGE =
  'Tu registro aún no está disponible. Te avisaremos cuando puedas consultarlo.';