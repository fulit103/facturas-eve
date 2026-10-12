/**
 * JavaScript evaluated inside the QuickJS context before the model's code.
 *
 * It turns the private host bridge (`__host`) into the documented library the
 * model uses — `airtable`, `chart`, `store`, `aq`/`op`, helpers — and keeps
 * the bridge itself in a closure the model's code cannot reach. Everything
 * here runs in the sandboxed interpreter: no network, filesystem, or env.
 */

export const PRELUDE_SOURCE = String.raw`
(function () {
  "use strict";
  var host = globalThis.__host;
  delete globalThis.__host;

  // --- console -------------------------------------------------------------
  function show(value) {
    if (typeof value === "string") return value;
    if (value instanceof Error) return value.name + ": " + value.message;
    try {
      if (value && typeof value.objects === "function" && typeof value.numRows === "function") {
        return value.print ? tableToText(value) : JSON.stringify(value.objects().slice(0, 20));
      }
      return JSON.stringify(value, null, 0);
    } catch (error) {
      return String(value);
    }
  }
  function tableToText(table) {
    var rows = table.objects({ limit: 20 });
    var names = table.columnNames();
    var lines = [names.join(" | ")];
    rows.forEach(function (row) {
      lines.push(names.map(function (name) { return String(row[name]); }).join(" | "));
    });
    if (table.numRows() > 20) lines.push("… (" + table.numRows() + " filas)");
    return lines.join("\n");
  }
  function log(prefix) {
    return function () {
      var parts = Array.prototype.slice.call(arguments).map(show);
      host.log(prefix + parts.join(" "));
    };
  }
  globalThis.console = Object.freeze({
    log: log(""),
    info: log(""),
    debug: log(""),
    warn: log("AVISO: "),
    error: log("ERROR: "),
    table: function (value) { host.log(show(value)); },
  });

  // --- Airtable (read-only, via the host gateway) ---------------------------
  class AirtableError extends Error {
    constructor(message) {
      super(message);
      this.name = "AirtableError";
    }
  }

  async function call(method, params) {
    var raw = await host.call(method, JSON.stringify(params || {}));
    var payload = JSON.parse(raw);
    if (payload.error) throw new AirtableError(payload.error.message);
    return payload.result;
  }

  function flatten(value) {
    if (Array.isArray(value)) return value.map(flatten);
    if (value && typeof value === "object") {
      if ("filename" in value) return value.filename;
      if ("name" in value && ("email" in value || "id" in value)) return value.name;
      if ("state" in value && "value" in value) return value.value;
      if ("label" in value) return value.label;
      return JSON.stringify(value);
    }
    return value;
  }

  function summarizeOptions(options) {
    if (!options) return null;
    if (options.choices) return options.choices.slice(0, 30).map(function (c) { return c.name; }).join(", ");
    if (options.linkedTableId) return "link -> " + (options.linkedTableName || options.linkedTableId);
    if (options.result && options.result.type) return "result: " + options.result.type;
    if (options.precision !== undefined) return "precision: " + options.precision;
    return null;
  }

  var airtable = Object.freeze({
    /** Tables you may read: [{ table, tableId, fields, primaryField, description }]. */
    listTables: async function () {
      var tables = await call("list_tables", {});
      return tables.map(function (t) {
        var primary = t.fields.find(function (f) { return f.id === t.primaryFieldId; });
        return {
          table: t.name,
          tableId: t.id,
          fields: t.fields.length,
          primaryField: primary ? primary.name : null,
          description: t.description || null,
        };
      });
    },
    /** Fields of a table: [{ field, type, fieldId, options, description }]. */
    describeTable: async function (table) {
      var schema = await call("describe_table", { table: table });
      return schema.fields.map(function (f) {
        return {
          field: f.name,
          type: f.type,
          fieldId: f.id,
          options: summarizeOptions(f.options),
          description: f.description || null,
        };
      });
    },
    /**
     * Every matching record as plain objects with _id, _createdTime and one key
     * per field (missing cells are null). Reads all pages or throws.
     * opts: { fields, formula, view, sort: [{ field, direction }], maxRecords }
     */
    records: async function (table, opts) {
      opts = opts || {};
      var params = { table: table };
      if (opts.fields) params.fields = [].concat(opts.fields);
      if (opts.formula) params.formula = opts.formula;
      if (opts.view) params.view = opts.view;
      if (opts.sort) params.sort = opts.sort;
      if (opts.maxRecords !== undefined) params.max_records = opts.maxRecords;
      var result = await call("list_records", params);
      var columns = result.field_order || [];
      var rows = result.records.map(function (record) {
        var row = { _id: record.id, _createdTime: record.createdTime || null };
        columns.forEach(function (name) { row[name] = null; });
        Object.keys(record.fields || {}).forEach(function (key) {
          row[key] = flatten(record.fields[key]);
        });
        return row;
      });
      if (!result.complete) {
        host.log(
          "AVISO: lectura parcial de '" + result.table + "' (" + rows.length +
          " registros, limitada por maxRecords). No es el total de la tabla."
        );
      }
      return rows;
    },
    /** One record by id as a plain object. */
    getRecord: async function (table, recordId) {
      var record = await call("get_record", { table: table, record_id: recordId });
      var row = { _id: record.id, _createdTime: record.createdTime || null };
      Object.keys(record.fields || {}).forEach(function (key) { row[key] = flatten(record.fields[key]); });
      return row;
    },
  });

  // --- charts ----------------------------------------------------------------
  /** Registers a Vega-Lite spec (inline data only) as a chart for the user. Returns its id. */
  function chart(spec, opts) {
    var title = opts && opts.title ? String(opts.title) : "";
    var data = spec;
    if (spec && typeof spec === "object" && spec.data && spec.data.values && typeof spec.data.values.objects === "function") {
      data = Object.assign({}, spec, { data: Object.assign({}, spec.data, { values: spec.data.values.objects() }) });
    }
    return host.chart(JSON.stringify(data), title);
  }

  // --- helpers -----------------------------------------------------------------
  /** 1234567.8 -> "$1.234.568" (es-CO grouping, no Intl in this runtime). */
  function money(value, decimals) {
    if (value === null || value === undefined || isNaN(value)) return "";
    var digits = decimals || 0;
    var negative = value < 0;
    var fixed = Math.abs(Number(value)).toFixed(digits);
    var parts = fixed.split(".");
    var integer = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ".");
    return (negative ? "-$" : "$") + integer + (parts[1] ? "," + parts[1] : "");
  }
  /** "2026-03-15" or Date -> "2026-03". */
  function month(value) {
    if (value === null || value === undefined) return null;
    if (value instanceof Date) return value.toISOString().slice(0, 7);
    return String(value).slice(0, 7);
  }

  // --- session store ------------------------------------------------------------
  function encode(value, path, skipped) {
    if (value === null || value === undefined) return null;
    if (typeof value === "function" || typeof value === "symbol") {
      skipped.push(path);
      return undefined;
    }
    if (value instanceof Date) return { $date: value.toISOString() };
    if (typeof value.objects === "function" && typeof value.columnNames === "function") {
      return { $table: value.objects() };
    }
    if (Array.isArray(value)) {
      return value.map(function (item, index) {
        var encoded = encode(item, path + "[" + index + "]", skipped);
        return encoded === undefined ? null : encoded;
      });
    }
    if (typeof value === "object") {
      var out = {};
      Object.keys(value).forEach(function (key) {
        var encoded = encode(value[key], path + "." + key, skipped);
        if (encoded !== undefined) out[key] = encoded;
      });
      return out;
    }
    if (typeof value === "number" && !isFinite(value)) return null;
    return value;
  }
  function decode(value) {
    if (Array.isArray(value)) return value.map(decode);
    if (value && typeof value === "object") {
      if (typeof value.$date === "string" && Object.keys(value).length === 1) return new Date(value.$date);
      if (Array.isArray(value.$table) && Object.keys(value).length === 1) return aq.from(value.$table);
      var out = {};
      Object.keys(value).forEach(function (key) { out[key] = decode(value[key]); });
      return out;
    }
    return value;
  }

  var store = {};

  // --- result rendering -----------------------------------------------------------
  var MAX_ROWS = 50;
  function isTable(value) {
    return value && typeof value.objects === "function" && typeof value.columnNames === "function";
  }
  function cell(value) {
    if (value === undefined) return null;
    if (value instanceof Date) return value.toISOString();
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") return isFinite(value) ? value : null;
    try { return JSON.stringify(value); } catch (e) { return String(value); }
  }
  function renderResult(value) {
    if (value === undefined) return null;
    if (isTable(value)) {
      var columns = value.columnNames();
      return {
        kind: "table",
        columns: columns,
        rows: value.objects({ limit: MAX_ROWS }).map(function (row) {
          return columns.map(function (name) { return cell(row[name]); });
        }),
        total_rows: value.numRows(),
        truncated: value.numRows() > MAX_ROWS,
      };
    }
    if (Array.isArray(value) && value.length > 0 && value.every(function (row) {
      return row && typeof row === "object" && !Array.isArray(row);
    })) {
      var names = [];
      value.slice(0, MAX_ROWS).forEach(function (row) {
        Object.keys(row).forEach(function (key) { if (names.indexOf(key) === -1) names.push(key); });
      });
      return {
        kind: "table",
        columns: names,
        rows: value.slice(0, MAX_ROWS).map(function (row) {
          return names.map(function (name) { return cell(row[name]); });
        }),
        total_rows: value.length,
        truncated: value.length > MAX_ROWS,
      };
    }
    var text;
    if (typeof value === "string") text = value;
    else {
      try { text = JSON.stringify(encode(value, "result", []), null, 2); } catch (e) { text = String(value); }
    }
    if (text === undefined) text = String(value);
    var truncated = text.length > 4000;
    return { kind: "text", text: truncated ? text.slice(0, 4000) + "\n… (truncado)" : text, truncated: truncated };
  }

  function describe(value) {
    if (isTable(value)) return { type: "table", rows: value.numRows(), columns: value.columnNames().slice(0, 25) };
    if (Array.isArray(value)) {
      var first = value[0];
      return {
        type: "array",
        length: value.length,
        columns: first && typeof first === "object" ? Object.keys(first).slice(0, 25) : undefined,
      };
    }
    if (value instanceof Date) return { type: "date", value: value.toISOString() };
    if (value && typeof value === "object") return { type: "object", keys: Object.keys(value).slice(0, 25) };
    if (typeof value === "function") return { type: "function" };
    return { type: typeof value, value: typeof value === "string" ? value.slice(0, 200) : value };
  }

  Object.defineProperty(globalThis, "__internals", {
    enumerable: false,
    configurable: false,
    writable: false,
    value: Object.freeze({
      restore: function (json) {
        var saved = JSON.parse(json);
        Object.keys(saved).forEach(function (key) { store[key] = decode(saved[key]); });
      },
      snapshot: function () {
        var out = {};
        var skipped = [];
        Object.keys(store).forEach(function (key) {
          var encoded = encode(store[key], key, skipped);
          if (encoded === undefined) return;
          out[key] = JSON.stringify(encoded);
        });
        var variables = Object.keys(store).map(function (key) {
          return Object.assign({ name: key }, describe(store[key]));
        });
        return JSON.stringify({ values: out, skipped: skipped, variables: variables });
      },
      render: function (value) { return JSON.stringify(renderResult(value)); },
    }),
  });

  globalThis.airtable = airtable;
  globalThis.AirtableError = AirtableError;
  globalThis.chart = chart;
  globalThis.money = money;
  globalThis.month = month;
  globalThis.op = aq.op;
  Object.defineProperty(globalThis, "store", { value: store, enumerable: true, writable: false });
})();
`;
