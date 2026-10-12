import variant from "@jitl/quickjs-singlefile-cjs-release-sync";
import {
  newQuickJSWASMModuleFromVariant,
  shouldInterruptAfterDeadline,
  type QuickJSContext,
  type QuickJSDeferredPromise,
  type QuickJSHandle,
  type QuickJSWASMModule,
} from "quickjs-emscripten-core";
import { z } from "zod";

import {
  AirtableReadError,
  type AirtableReadOnlyGateway,
  type AirtableTableSchema,
} from "#lib/codeact/airtable-gateway.js";
import { ChartSpecError, normalizeChartSpec, type VegaLiteSpec } from "#lib/codeact/chart-render.js";
import { ARQUERO_SOURCE } from "#lib/codeact/generated/assets.js";
import { PRELUDE_SOURCE } from "#lib/codeact/js-prelude.js";

/**
 * Runs model-written JavaScript in a QuickJS (WebAssembly) interpreter inside
 * the app runtime. The interpreter has no network, filesystem, timers, or
 * environment; it reaches Airtable only through `host.call`, which this module
 * routes to the read-only gateway. Time and memory are capped per execution.
 *
 * Nothing survives between executions except `store`, which the caller
 * persists (as JSON) in durable per-session state.
 */

export const DEFAULT_TIMEOUT_MS = 30_000;
export const DEFAULT_MEMORY_MB = 256;
export const MAX_STORE_BYTES = 3_000_000;
const MAX_LOG_CHARS = 6_000;
const MAX_RPC_CALLS = 40;
const MAX_CHARTS = 4;
const USER_FILENAME = "execute_js.js";

const TEXT_CODEC_POLYFILL = `
globalThis.TextDecoder = class TextDecoder {
  decode(bytes) {
    if (!bytes) return "";
    let s = "";
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    try { return decodeURIComponent(escape(s)); } catch (e) { return s; }
  }
};
globalThis.TextEncoder = class TextEncoder {
  encode(text) {
    const s = unescape(encodeURIComponent(String(text)));
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  }
};`;

export interface ExecutionLimits {
  timeoutMs: number;
  memoryMb: number;
}

export interface ChartOutput {
  id: string;
  title: string;
  /** Normalized Vega-Lite spec with inline data. Rendered by the UI and Telegram. */
  spec: VegaLiteSpec;
}

export interface TableResult {
  kind: "table";
  columns: string[];
  rows: unknown[][];
  total_rows: number;
  truncated: boolean;
}

export interface TextResult {
  kind: "text";
  text: string;
  truncated: boolean;
}

export interface ExecutionError {
  type: string;
  message: string;
  line: number | null;
  code_line: string | null;
  stack: string;
}

export interface DataRead {
  table: string;
  records: number;
  complete: boolean;
  pages: number;
  formula: string | null;
  view: string | null;
  max_records: number | null;
}

/** Serialized `store`: one JSON string per key. */
export type StoreSnapshot = Record<string, string>;

export interface ExecutionOutput {
  ok: boolean;
  executionId: string;
  stdout: string;
  stdoutTruncated: boolean;
  result: TableResult | TextResult | null;
  error: ExecutionError | null;
  charts: ChartOutput[];
  dataReads: DataRead[];
  variables: Array<Record<string, unknown>>;
  notPersisted: string[];
  warnings: string[];
  durationMs: number;
}

export interface ExecuteJsInput {
  code: string;
  /** `null` when Airtable is not configured; reads then fail with a clear message. */
  gateway: AirtableReadOnlyGateway | null;
  /** `store` saved by the previous execution in this session. */
  store: StoreSnapshot;
  limits?: Partial<ExecutionLimits>;
}

export interface ExecuteJsResult {
  output: ExecutionOutput;
  /** `store` to persist for the next execution (unchanged when the run crashed). */
  store: StoreSnapshot;
}

let modulePromise: Promise<QuickJSWASMModule> | null = null;

function quickJs(): Promise<QuickJSWASMModule> {
  modulePromise ??= newQuickJSWASMModuleFromVariant(variant).catch((error: unknown) => {
    modulePromise = null;
    throw error;
  });
  return modulePromise;
}

const listRecordsParamsSchema = z.object({
  table: z.string().min(1),
  fields: z.array(z.string().min(1)).max(100).optional(),
  formula: z.string().max(4_000).optional(),
  view: z.string().max(200).optional(),
  sort: z
    .array(z.object({ field: z.string().min(1), direction: z.enum(["asc", "desc"]).optional() }))
    .max(10)
    .optional(),
  max_records: z.number().int().positive().optional(),
});

export async function executeJs(input: ExecuteJsInput): Promise<ExecuteJsResult> {
  const limits: ExecutionLimits = {
    timeoutMs: input.limits?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    memoryMb: input.limits?.memoryMb ?? DEFAULT_MEMORY_MB,
  };
  const startedAt = Date.now();
  const deadline = startedAt + limits.timeoutMs;
  const executionId = `${startedAt.toString(36)}${Math.random().toString(36).slice(2, 8)}`;

  const module = await quickJs();
  const runtime = module.newRuntime();
  runtime.setMemoryLimit(limits.memoryMb * 1024 * 1024);
  runtime.setMaxStackSize(1024 * 1024);
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(deadline));
  const vm = runtime.newContext();

  const logs: string[] = [];
  let logChars = 0;
  let logTruncated = false;
  const charts: ChartOutput[] = [];
  const dataReads: DataRead[] = [];
  const warnings: string[] = [];
  let rpcCalls = 0;
  let pendingHostCalls = 0;
  // Bridge promises still owned by the host. QuickJS aborts if the runtime is
  // freed while any of them is alive, so they are released before teardown.
  const openDeferreds = new Set<QuickJSDeferredPromise>();

  const log = (text: string) => {
    if (logChars >= MAX_LOG_CHARS) {
      logTruncated = true;
      return;
    }
    const slice = text.slice(0, MAX_LOG_CHARS - logChars);
    if (slice.length < text.length) logTruncated = true;
    logs.push(slice);
    logChars += slice.length + 1;
  };

  try {
    installHost(vm, {
      log,
      chart(specJson, title) {
        if (charts.length >= MAX_CHARTS) {
          throw new ChartSpecError(`Máximo ${MAX_CHARTS} gráficos por ejecución.`);
        }
        let spec: unknown;
        try {
          spec = JSON.parse(specJson);
        } catch {
          throw new ChartSpecError("La especificación del gráfico no es JSON válido.");
        }
        const normalized = normalizeChartSpec(spec, title);
        const id = `${executionId}-${charts.length + 1}`;
        const resolvedTitle =
          typeof normalized.title === "string"
            ? normalized.title
            : isRecord(normalized.title) && typeof normalized.title.text === "string"
              ? normalized.title.text
              : title || "Gráfico";
        charts.push({ id, title: resolvedTitle, spec: normalized });
        return id;
      },
      async call(method, paramsJson) {
        rpcCalls += 1;
        if (rpcCalls > MAX_RPC_CALLS) {
          throw new AirtableReadError(
            `Máximo ${MAX_RPC_CALLS} lecturas de Airtable por ejecución. Guardá los datos en store y reutilizalos.`,
            { code: "TOO_MANY_CALLS" },
          );
        }
        const params = JSON.parse(paramsJson) as Record<string, unknown>;
        const result = await dispatchRpc(input.gateway, method, params);
        if (method === "list_records") {
          const read = result as { table: string; records: unknown[]; complete: boolean; pages: number };
          dataReads.push({
            table: read.table,
            records: read.records.length,
            complete: read.complete,
            pages: read.pages,
            formula: typeof params.formula === "string" ? params.formula : null,
            view: typeof params.view === "string" ? params.view : null,
            max_records: typeof params.max_records === "number" ? params.max_records : null,
          });
        }
        return result;
      },
      onPending(delta) {
        pendingHostCalls += delta;
      },
      deferreds: openDeferreds,
    });

    evalOrThrow(vm, TEXT_CODEC_POLYFILL, "polyfill.js");
    evalOrThrow(vm, ARQUERO_SOURCE, "arquero.js");
    evalOrThrow(vm, PRELUDE_SOURCE, "prelude.js");

    try {
      callInternal(vm, "restore", JSON.stringify(decodeSnapshot(input.store)));
    } catch {
      warnings.push("No pude restaurar los datos guardados en store; empiezo de cero.");
    }
  } catch (error) {
    teardown(vm, openDeferreds);
    throw error;
  }

  let error: ExecutionError | null = null;
  let result: TableResult | TextResult | null = null;

  // The user's code becomes the body of an async function: `await` works, and
  // `return` sets the result. The prefix stays on line 1 so line numbers match.
  const wrapped = `(async () => {${input.code}\n})()`;
  const evaluated = vm.evalCode(wrapped, USER_FILENAME);
  if (evaluated.error) {
    error = toExecutionError(vm, evaluated.error, input.code);
    evaluated.error.dispose();
  } else {
    const promiseHandle = evaluated.value;
    try {
      const settled = await settleWithDeadline(vm, promiseHandle, deadline, () => pendingHostCalls);
      if (settled.kind === "timeout") {
        error = timeoutError(limits);
      } else if (settled.kind === "stalled") {
        error = {
          type: "StalledPromise",
          message:
            "El código quedó esperando una promesa que nunca se resuelve. Usá await solo con funciones de airtable.",
          line: null,
          code_line: null,
          stack: "",
        };
      } else if (settled.result.error) {
        error = toExecutionError(vm, settled.result.error, input.code);
        settled.result.error.dispose();
      } else {
        const valueHandle = settled.result.value;
        try {
          const rendered = callInternal(vm, "render", valueHandle);
          result = rendered === "null" ? null : (JSON.parse(rendered) as TableResult | TextResult);
        } catch (renderError) {
          warnings.push(`No pude mostrar el resultado: ${(renderError as Error).message}`);
        } finally {
          valueHandle.dispose();
        }
      }
    } finally {
      promiseHandle.dispose();
    }
  }

  let store = input.store;
  let variables: Array<Record<string, unknown>> = [];
  let notPersisted: string[] = [];
  if (error?.type !== "ExecutionTimeout" && error?.type !== "MemoryLimit") {
    try {
      // Give the snapshot its own short budget even if the user code used it all.
      runtime.setInterruptHandler(shouldInterruptAfterDeadline(Date.now() + 5_000));
      const snapshot = JSON.parse(callInternal(vm, "snapshot")) as {
        values: Record<string, string>;
        skipped: string[];
        variables: Array<Record<string, unknown>>;
      };
      const capped = capStore(snapshot.values);
      store = capped.store;
      notPersisted = [...snapshot.skipped, ...capped.dropped];
      variables = snapshot.variables;
      if (capped.dropped.length > 0) {
        warnings.push(
          `No guardé ${capped.dropped.join(", ")} en store: supera ${MAX_STORE_BYTES / 1_000_000} MB. ` +
            "Guardá datos agregados o solo los campos necesarios.",
        );
      }
    } catch {
      warnings.push("No pude guardar store para la próxima ejecución.");
    }
  } else {
    warnings.push("La ejecución se cortó: store quedó como estaba antes.");
  }

  teardown(vm, openDeferreds);

  return {
    store,
    output: {
      ok: error === null,
      executionId,
      stdout: logs.join("\n"),
      stdoutTruncated: logTruncated,
      result,
      error,
      charts,
      dataReads,
      variables,
      notPersisted,
      warnings,
      durationMs: Date.now() - startedAt,
    },
  };
}

interface HostBridge {
  log(text: string): void;
  chart(specJson: string, title: string): string;
  call(method: string, paramsJson: string): Promise<unknown>;
  onPending(delta: number): void;
  deferreds: Set<QuickJSDeferredPromise>;
}

/** Frees bridge promises that never settled, then the context and its runtime. */
function teardown(vm: QuickJSContext, deferreds: Set<QuickJSDeferredPromise>): void {
  const runtime = vm.runtime;
  for (const deferred of deferreds) {
    if (deferred.alive) deferred.dispose();
  }
  deferreds.clear();
  vm.dispose();
  runtime.dispose();
}

/** Exposes `__host` (log, chart, call) to the prelude, which hides it from user code. */
function installHost(vm: QuickJSContext, bridge: HostBridge): void {
  const host = vm.newObject();

  const logFn = vm.newFunction("log", (textHandle) => {
    bridge.log(vm.getString(textHandle));
  });
  vm.setProp(host, "log", logFn);
  logFn.dispose();

  const chartFn = vm.newFunction("chart", (specHandle, titleHandle) => {
    try {
      return vm.newString(bridge.chart(vm.getString(specHandle), vm.getString(titleHandle)));
    } catch (error) {
      return { error: vm.newError({ name: "ChartError", message: (error as Error).message }) };
    }
  });
  vm.setProp(host, "chart", chartFn);
  chartFn.dispose();

  const callFn = vm.newFunction("call", (methodHandle, paramsHandle) => {
    const method = vm.getString(methodHandle);
    const params = vm.getString(paramsHandle);
    const deferred = vm.newPromise();
    bridge.deferreds.add(deferred);
    bridge.onPending(1);
    bridge
      .call(method, params)
      .then(
        (result) => {
          if (!vm.alive || !deferred.alive) return;
          const value = vm.newString(JSON.stringify({ result }));
          deferred.resolve(value);
          value.dispose();
        },
        (error: unknown) => {
          if (!vm.alive || !deferred.alive) return;
          const message =
            error instanceof AirtableReadError
              ? error.message
              : error instanceof SyntaxError
                ? "Parámetros inválidos."
                : "Error interno al leer Airtable.";
          const value = vm.newString(JSON.stringify({ error: { message } }));
          deferred.resolve(value);
          value.dispose();
        },
      )
      .finally(() => {
        bridge.onPending(-1);
        if (!vm.alive) return;
        vm.runtime.executePendingJobs();
        bridge.deferreds.delete(deferred);
        if (deferred.alive) deferred.dispose();
      });
    return deferred.handle;
  });
  vm.setProp(host, "call", callFn);
  callFn.dispose();

  vm.setProp(vm.global, "__host", host);
  host.dispose();
}

function evalOrThrow(vm: QuickJSContext, source: string, filename: string): void {
  const result = vm.evalCode(source, filename);
  if (result.error) {
    const dumped = vm.dump(result.error) as { message?: string };
    result.error.dispose();
    throw new Error(`QuickJS setup failed in ${filename}: ${dumped?.message ?? "unknown error"}`);
  }
  result.value.dispose();
}

/** Calls `__internals[name](arg)` and returns its string result. */
function callInternal(vm: QuickJSContext, name: string, arg?: string | QuickJSHandle): string {
  const internals = vm.getProp(vm.global, "__internals");
  const fn = vm.getProp(internals, name);
  const argHandle = typeof arg === "string" ? vm.newString(arg) : undefined;
  const args = arg === undefined ? [] : [argHandle ?? (arg as QuickJSHandle)];
  try {
    const result = vm.callFunction(fn, internals, ...args);
    if (result.error) {
      const dumped = vm.dump(result.error) as { message?: string };
      result.error.dispose();
      throw new Error(dumped?.message ?? `__internals.${name} failed`);
    }
    const value = vm.getString(result.value);
    result.value.dispose();
    return value;
  } finally {
    argHandle?.dispose();
    fn.dispose();
    internals.dispose();
  }
}

type PromiseResult = Awaited<ReturnType<QuickJSContext["resolvePromise"]>>;

type Settled = { kind: "settled"; result: PromiseResult } | { kind: "timeout" } | { kind: "stalled" };

/**
 * Drives the QuickJS job queue until the user's promise settles. Host calls
 * re-run pending jobs when they resolve. Two guards: the deadline, and a
 * promise that is still pending with no host call in flight, which can never
 * settle (QuickJS here has no timers or I/O of its own).
 */
async function settleWithDeadline(
  vm: QuickJSContext,
  promiseHandle: QuickJSHandle,
  deadline: number,
  pendingHostCalls: () => number,
): Promise<Settled> {
  let done = false;
  const native = vm.resolvePromise(promiseHandle).then((result) => {
    done = true;
    return { kind: "settled" as const, result };
  });
  vm.runtime.executePendingJobs();

  let timer: ReturnType<typeof setTimeout> | undefined;
  let polling = true;
  const timeout = new Promise<Settled>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), Math.max(0, deadline - Date.now()));
  });
  const stall = (async (): Promise<Settled> => {
    while (polling) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      if (done || !polling) break;
      if (pendingHostCalls() === 0) {
        vm.runtime.executePendingJobs();
        // Let resolvePromise's native callbacks run before deciding.
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (!done && pendingHostCalls() === 0) return { kind: "stalled" };
      }
    }
    return new Promise<Settled>(() => {});
  })();

  try {
    return await Promise.race([native, timeout, stall]);
  } finally {
    polling = false;
    clearTimeout(timer);
  }
}

function timeoutError(limits: ExecutionLimits): ExecutionError {
  return {
    type: "ExecutionTimeout",
    message: `La ejecución superó el límite de ${Math.round(limits.timeoutMs / 1000)} s. Reducí los datos (filtros, menos campos) o dividí el trabajo.`,
    line: null,
    code_line: null,
    stack: "",
  };
}

function toExecutionError(vm: QuickJSContext, handle: QuickJSHandle, code: string): ExecutionError {
  const dumped = vm.dump(handle) as { name?: string; message?: string; stack?: string } | string;
  const name = typeof dumped === "object" && dumped !== null ? (dumped.name ?? "Error") : "Error";
  const message =
    typeof dumped === "object" && dumped !== null ? String(dumped.message ?? "") : String(dumped);
  const stack = typeof dumped === "object" && dumped !== null ? String(dumped.stack ?? "") : "";

  if (name === "InternalError" && /interrupted/iu.test(message)) {
    return {
      type: "ExecutionTimeout",
      message: "La ejecución superó el límite de tiempo y fue interrumpida. Reducí los datos o dividí el trabajo.",
      line: null,
      code_line: null,
      stack: "",
    };
  }
  if (/out of memory/iu.test(message)) {
    return {
      type: "MemoryLimit",
      message: "La ejecución superó el límite de memoria. Pedí menos campos o filtrá antes de cargar.",
      line: null,
      code_line: null,
      stack: "",
    };
  }

  const match = new RegExp(`${USER_FILENAME.replace(".", "\\.")}:(\\d+)`, "u").exec(stack);
  const line = match === null ? null : Number(match[1]);
  const lines = code.split("\n");
  const codeLine = line !== null && line >= 1 && line <= lines.length ? lines[line - 1]!.trim() : null;
  const userStack = stack
    .split("\n")
    .filter((entry) => entry.includes(USER_FILENAME) || !/prelude\.js|arquero\.js/u.test(entry))
    .join("\n")
    .slice(0, 2_000);

  return { type: name, message: message.slice(0, 1_000), line, code_line: codeLine, stack: userStack };
}

async function dispatchRpc(
  gateway: AirtableReadOnlyGateway | null,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  if (gateway === null) {
    throw new AirtableReadError(
      "Airtable no está configurado en este entorno (faltan AIRTABLE_BASE_ID y el token de lectura).",
      { code: "NOT_CONFIGURED" },
    );
  }

  switch (method) {
    case "list_tables":
      return (await gateway.listTables()).map(publicTableSchema);
    case "describe_table":
      return publicTableSchema(await gateway.resolveTable(requireString(params.table, "table")));
    case "list_records": {
      const parsed = listRecordsParamsSchema.safeParse(params);
      if (!parsed.success) {
        throw new AirtableReadError(
          `Parámetros inválidos para airtable.records: ${parsed.error.issues
            .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
            .join("; ")}`,
          { code: "INVALID_ARGUMENT" },
        );
      }
      const { table, fields, formula, view, sort, max_records: maxRecords } = parsed.data;
      const schema = await gateway.resolveTable(table);
      const result = await gateway.listRecords({ table, fields, formula, view, sort, maxRecords });
      return { ...result, field_order: fields ?? schema.fields.map((field) => field.name) };
    }
    case "get_record":
      return gateway.getRecord(
        requireString(params.table, "table"),
        requireString(params.record_id, "record_id"),
      );
    default:
      throw new AirtableReadError(`Operación no permitida: ${method}. El acceso es de solo lectura.`, {
        code: "METHOD_NOT_ALLOWED",
      });
  }
}

function publicTableSchema(table: AirtableTableSchema) {
  return {
    id: table.id,
    name: table.name,
    description: table.description ?? null,
    primaryFieldId: table.primaryFieldId,
    fields: table.fields.map((field) => ({
      id: field.id,
      name: field.name,
      type: field.type,
      description: field.description ?? null,
      options: field.options ?? null,
    })),
  };
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new AirtableReadError(`Falta el parámetro "${name}".`, { code: "INVALID_ARGUMENT" });
  }
  return value;
}

/** Stored values are JSON strings per key; the prelude expects one object. */
function decodeSnapshot(store: StoreSnapshot): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, json] of Object.entries(store)) {
    try {
      out[key] = JSON.parse(json);
    } catch {
      // Corrupt entries are dropped rather than failing the run.
    }
  }
  return out;
}

/** Keeps the smallest entries that fit the budget; reports the rest. */
function capStore(values: Record<string, string>): { store: StoreSnapshot; dropped: string[] } {
  const entries = Object.entries(values).sort((a, b) => a[1].length - b[1].length);
  const store: StoreSnapshot = {};
  const dropped: string[] = [];
  let total = 0;
  for (const [key, json] of entries) {
    if (total + json.length > MAX_STORE_BYTES) {
      dropped.push(key);
      continue;
    }
    store[key] = json;
    total += json.length;
  }
  return { store, dropped };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
