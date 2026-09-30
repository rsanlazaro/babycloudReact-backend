// backend/services/seguroStatus.js
// Computed columns for "Listado de seguros" (Baby site).
// Policies = sort_ges_seguro_mat (the "Seguro med" tab of each Sort_GESCA
// register); payments = sort_ges_seguro_mat_cuotas.
//
// ⚠ PROVISIONAL RULES — the real conditions for "Solicitud de seguro" and
// "Status Gral" will be defined later. Change them ONLY here; the list page
// just displays { key, label, color }.

const today0 = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d; };
const asDate = (v) => (v ? new Date(v) : null);

/** A payment counts as paid once it has a payment date; cancelled ones are skipped. */
export const isCuotaPaid = (c) => !!c.fecha_pago;
const isCuotaActive = (c) => c.status !== 'cancelado';

/** Next payment still due (lowest number, not paid, not cancelled) or null. */
export const nextCuota = (cuotas = []) =>
  cuotas
    .filter(c => isCuotaActive(c) && !isCuotaPaid(c))
    .sort((a, b) => a.cuota_num - b.cuota_num)[0] || null;

/**
 * Solicitud de seguro (request state) — provisional:
 *   start date (fecha_alta) set → Autorizada
 *   request date set            → Solicitada
 *   otherwise                   → Pendiente
 */
export const computeSolicitud = (p) => {
  if (p.fecha_alta)      return { key: 'autorizada', label: 'Autorizada', color: 'success' };
  if (p.fecha_solicitud) return { key: 'solicitada', label: 'Solicitada', color: 'warning' };
  return { key: 'pendiente', label: 'Pendiente', color: 'secondary' };
};

/**
 * Status Gral (general state) — provisional:
 *   no start date                 → Sin iniciar
 *   expiry date passed            → Vencida
 *   an unpaid payment is overdue  → Carencia   (same meaning as in the Seguro med tab)
 *   start date still in the future→ Por iniciar
 *   otherwise                     → Vigente
 */
export const computeStatusGral = (p, cuotas = []) => {
  const hoy = today0();
  const alta = asDate(p.fecha_alta);
  const venc = asDate(p.fecha_vencimiento);
  if (!alta) return { key: 'sin_iniciar', label: 'Sin iniciar', color: 'secondary' };
  if (venc && venc < hoy) return { key: 'vencida', label: 'Vencida', color: 'dark' };
  const overdue = cuotas.some(c => isCuotaActive(c) && !isCuotaPaid(c) && c.vencimiento && asDate(c.vencimiento) < hoy);
  if (overdue) return { key: 'carencia', label: 'Carencia', color: 'danger' };
  if (alta > hoy) return { key: 'por_iniciar', label: 'Por iniciar', color: 'info' };
  return { key: 'vigente', label: 'Vigente', color: 'success' };
};

/** "2 de 4" for the next payment; "4 de 4" + liquidado when all are paid. */
export const computePago = (cuotas = []) => {
  const active = cuotas.filter(isCuotaActive);
  if (!active.length) return { texto: null, liquidado: false };
  const total = Number(active[0].total_cuotas) || active.length;
  const next = nextCuota(active);
  return next
    ? { texto: `${next.cuota_num} de ${total}`, liquidado: false }
    : { texto: `${total} de ${total}`, liquidado: true };
};

/** Year of the policy: start date → request date → creation date. */
export const computeAnio = (p) => {
  const d = asDate(p.fecha_alta) || asDate(p.fecha_solicitud) || asDate(p.created_at);
  return d ? d.getFullYear() : null;
};