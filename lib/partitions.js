// lib/partitions.js
function monthKey(d = new Date()) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${y}_${m}`; // ex: 2025_11
}
function partitionName(d = new Date()) {
  return `public.funnel_events_${monthKey(d)}`;
}
module.exports = { monthKey, partitionName };
