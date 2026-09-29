// backend/services/contracts.js
// Contracts ("contrato") and the payment schemes that belong to each one.
// Keep in sync with CONTRACT_OPTIONS / SCHEME_OPTIONS in
// frontend/src/views/babysite/progestor/PaymentsGestForm.js.
//
// To add Nora's schemes later: put their values in CONTRACT_SCHEMES.Nora here
// and in SCHEME_OPTIONS (with contrato: 'Nora') in the form.

export const DEFAULT_CONTRACT = 'Babyboom';

export const CONTRACT_SCHEMES = {
  Babyboom: [375000, 400000, 450000, 475000],
  Nora: [], // added later
};

export const CONTRACTS = Object.keys(CONTRACT_SCHEMES);

export const isValidContract = (c) => CONTRACTS.includes(c);

export const isSchemeInContract = (contrato, schemeValue) =>
  (CONTRACT_SCHEMES[contrato] || []).includes(Math.round(Number(schemeValue)));

/** Contract that owns a scheme value (first match), or null */
export const contractForScheme = (schemeValue) =>
  CONTRACTS.find(c => isSchemeInContract(c, schemeValue)) || null;

export const formatSchemeForMessage = (v) =>
  `$${Math.round(Number(v)).toLocaleString('en-US')}`;