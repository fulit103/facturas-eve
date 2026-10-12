/**
 * es-CO number and Spanish date formatting for Vega charts. Shared by the
 * server-side renderer (Telegram PNGs) and the Web Chat (vega-embed) so a
 * chart reads the same in both places: `$1.234.567`, "mar 2026".
 */

export const ES_CO_FORMAT_LOCALE = {
  decimal: ",",
  thousands: ".",
  grouping: [3],
  currency: ["$", ""],
} as const;

export const ES_TIME_FORMAT_LOCALE = {
  dateTime: "%A, %e de %B de %Y, %X",
  date: "%d/%m/%Y",
  time: "%H:%M:%S",
  periods: ["AM", "PM"],
  days: ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"],
  shortDays: ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"],
  months: [
    "enero",
    "febrero",
    "marzo",
    "abril",
    "mayo",
    "junio",
    "julio",
    "agosto",
    "septiembre",
    "octubre",
    "noviembre",
    "diciembre",
  ],
  shortMonths: ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"],
} as const;
