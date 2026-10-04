import { randomBytes } from "node:crypto";

import { z } from "zod";

import {
  AirtableReadError,
  type AirtableReadOnlyGateway,
  type AirtableTableSchema,
} from "#lib/codeact/airtable-gateway.js";
import { PROTOCOL_PREFIX, RUNNER_SOURCE } from "#lib/codeact/runner-source.js";

/**
 * Host side of `execute_python`: writes the runner and the model's code into
 * the session sandbox, runs it, answers the runner's Airtable RPC requests
 * through the read-only gateway, enforces the hard time limit, and collects
 * the structured result plus any chart PNGs.
 *
 * The sandbox is per durable session, so variables persisted by the runner
 * (`/workspace/.codeact/state`) are isolated between users and conversations.
 */

export const CODEACT_HOME = "/workspace/.codeact";
/** Created by the sandbox bootstrap; falls back to the system python3. */
export const CODEACT_VENV_PYTHON = "$HOME/.codeact-venv/bin/python";

export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_MEMORY_MB = 1024;
/** Extra time after the in-process alarm before the host kills the process. */
const KILL_GRACE_MS = 10_000;
const MAX_RPC_CALLS = 40;
const MAX_STDERR_CHARS = 2_000;
export const MAX_CHART_BYTES = 1_500_000;

/** The subset of eve's sandbox handle the executor needs. */
export interface CodeSandbox {
  writeTextFile(options: { path: string; content: string }): PromiseLike<void>;
  readBinaryFile(options: { path: string }): PromiseLike<Uint8Array | null>;
  spawn(options: {
    command: string;
    env?: Record<string, string>;
    abortSignal?: AbortSignal;
  }): PromiseLike<{
    readonly stdout: ReadableStream<Uint8Array>;
    readonly stderr: ReadableStream<Uint8Array>;
    wait(): PromiseLike<{ exitCode: number }>;
    kill(): PromiseLike<void>;
  }>;
}

export interface ExecutionLimits {
  timeoutMs: number;
  memoryMb: number;
}

export interface ChartOutput {
  id: string;
  title: string;
  mediaType: "image/png";
  path: string;
  width: number;
  height: number;
  /** PNG bytes for the UI and Telegram. Never sent to the model. */
  dataBase64: string | null;
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
  traceback: string;
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

/** Raised when the sandbox cannot run Python at all (not a bug in the model's code). */
export class CodeEnvironmentError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "CodeEnvironmentError";
  }
}

export interface ExecutePythonInput {
  sandbox: CodeSandbox;
  code: string;
  /** `null` when Airtable is not configured; RPC calls then fail with a clear message. */
  gateway: AirtableReadOnlyGateway | null;
  limits?: Partial<ExecutionLimits>;
  abortSignal?: AbortSignal;
  /** Overrides for tests that run against a local directory. */
  home?: string;
  pythonCommand?: string;
}

const runnerDoneSchema = z.object({
  type: z.literal("done"),
  ok: z.boolean(),
  stdout: z.string(),
  stdout_truncated: z.boolean(),
  result: z.unknown().nullable(),
  error: z
    .object({
      type: z.string(),
      message: z.string(),
      line: z.number().nullable(),
      code_line: z.string().nullable(),
      traceback: z.string(),
    })
    .nullable(),
  charts: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      path: z.string(),
      width: z.number(),
      height: z.number(),
    }),
  ),
  data_reads: z.array(z.record(z.string(), z.unknown())),
  variables: z.array(z.record(z.string(), z.unknown())),
  not_persisted: z.array(z.string()),
  warnings: z.array(z.string()),
  duration_ms: z.number(),
});

const rpcRequestSchema = z.object({
  type: z.literal("rpc"),
  id: z.string().regex(/^[a-f0-9]{32}$/u),
  method: z.string(),
  params: z.record(z.string(), z.unknown()),
});

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

export async function executePython(input: ExecutePythonInput): Promise<ExecutionOutput> {
  const limits: ExecutionLimits = {
    timeoutMs: input.limits?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    memoryMb: input.limits?.memoryMb ?? DEFAULT_MEMORY_MB,
  };
  const home = input.home ?? CODEACT_HOME;
  const executionId = `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;
  const startedAt = Date.now();

  await input.sandbox.writeTextFile({ path: `${home}/runner.py`, content: RUNNER_SOURCE });
  await input.sandbox.writeTextFile({ path: `${home}/exec/${executionId}.py`, content: input.code });

  const python =
    input.pythonCommand ??
    `PY="${CODEACT_VENV_PYTHON}"; [ -x "$PY" ] || PY="$(command -v python3)"; ` +
      `[ -n "$PY" ] || { echo "python3 not found" >&2; exit 127; }; "$PY"`;
  const command = `cd ${shellQuote(home)} && ${python} runner.py`;

  const child = await input.sandbox.spawn({
    command,
    abortSignal: input.abortSignal,
    env: {
      CODEACT_HOME: home,
      CODEACT_EXEC_ID: executionId,
      CODEACT_TIMEOUT_S: String(Math.max(1, Math.round(limits.timeoutMs / 1000))),
      CODEACT_MEMORY_MB: String(limits.memoryMb),
      MPLBACKEND: "Agg",
      OPENBLAS_NUM_THREADS: "1",
      OMP_NUM_THREADS: "1",
      MKL_NUM_THREADS: "1",
      PYTHONDONTWRITEBYTECODE: "1",
      PYTHONIOENCODING: "utf-8",
    },
  });

  let timedOut = false;
  const killTimer = setTimeout(() => {
    timedOut = true;
    void child.kill();
  }, limits.timeoutMs + KILL_GRACE_MS);

  const rpc = createRpcHandler({
    sandbox: input.sandbox,
    gateway: input.gateway,
    home,
  });

  let done: z.infer<typeof runnerDoneSchema> | null = null;
  const stdoutTask = readLines(child.stdout, async (line) => {
    if (!line.startsWith(PROTOCOL_PREFIX)) return;
    let message: unknown;
    try {
      message = JSON.parse(line.slice(PROTOCOL_PREFIX.length));
    } catch {
      return;
    }
    const kind = (message as { type?: unknown }).type;
    if (kind === "rpc") {
      const parsed = rpcRequestSchema.safeParse(message);
      if (parsed.success) await rpc(parsed.data);
    } else if (kind === "done") {
      const parsed = runnerDoneSchema.safeParse(message);
      if (parsed.success) done = parsed.data;
    }
  });
  const stderrTask = readAll(child.stderr, MAX_STDERR_CHARS);

  let exitCode: number;
  try {
    exitCode = (await child.wait()).exitCode;
  } finally {
    clearTimeout(killTimer);
  }
  await stdoutTask;
  const stderr = await stderrTask;

  const finished = done as z.infer<typeof runnerDoneSchema> | null;
  if (finished === null) {
    return failureWithoutResult({ executionId, exitCode, stderr, timedOut, limits, startedAt });
  }

  const charts = await collectCharts(input.sandbox, finished.charts);
  return {
    ok: finished.ok,
    executionId,
    stdout: finished.stdout,
    stdoutTruncated: finished.stdout_truncated,
    result: (finished.result ?? null) as TableResult | TextResult | null,
    error: finished.error,
    charts,
    dataReads: finished.data_reads as unknown as DataRead[],
    variables: finished.variables,
    notPersisted: finished.not_persisted,
    warnings: finished.warnings,
    durationMs: Date.now() - startedAt,
  };
}

function failureWithoutResult(input: {
  executionId: string;
  exitCode: number;
  stderr: string;
  timedOut: boolean;
  limits: ExecutionLimits;
  startedAt: number;
}): ExecutionOutput {
  const { stderr, exitCode } = input;
  if (exitCode === 127 || /python3 not found|No module named '(pandas|numpy|matplotlib)'/u.test(stderr)) {
    throw new CodeEnvironmentError(
      "El entorno de análisis no tiene Python con pandas y matplotlib. " +
        "Revisá la instalación del sandbox (agent/sandbox.ts).",
    );
  }

  let error: ExecutionError;
  if (input.timedOut) {
    error = {
      type: "ExecutionTimeout",
      message: `La ejecución superó el límite de ${Math.round(input.limits.timeoutMs / 1000)} s y fue detenida. Reducí los datos o dividí el trabajo.`,
      line: null,
      code_line: null,
      traceback: "",
    };
  } else if (exitCode === 137 || /MemoryError|Killed|Cannot allocate memory/u.test(stderr)) {
    error = {
      type: "MemoryLimit",
      message: `La ejecución superó el límite de memoria (${input.limits.memoryMb} MB). Pedí menos campos o filtrá antes de cargar.`,
      line: null,
      code_line: null,
      traceback: stderr,
    };
  } else {
    error = {
      type: "RunnerCrashed",
      message: `El proceso de Python terminó inesperadamente (código ${exitCode}).`,
      line: null,
      code_line: null,
      traceback: stderr,
    };
  }

  return {
    ok: false,
    executionId: input.executionId,
    stdout: "",
    stdoutTruncated: false,
    result: null,
    error,
    charts: [],
    dataReads: [],
    variables: [],
    notPersisted: [],
    warnings: ["Las variables de esta ejecución no se guardaron."],
    durationMs: Date.now() - input.startedAt,
  };
}

function createRpcHandler(input: {
  sandbox: CodeSandbox;
  gateway: AirtableReadOnlyGateway | null;
  home: string;
}) {
  let calls = 0;

  return async (request: z.infer<typeof rpcRequestSchema>): Promise<void> => {
    calls += 1;
    let payload: { result: unknown } | { error: { code: string; message: string } };
    try {
      if (calls > MAX_RPC_CALLS) {
        throw new AirtableReadError(
          `Máximo ${MAX_RPC_CALLS} lecturas de Airtable por ejecución. Guardá los DataFrames en variables y reutilizalos.`,
          { code: "TOO_MANY_CALLS" },
        );
      }
      payload = { result: await dispatchRpc(input.gateway, request.method, request.params) };
    } catch (error) {
      payload = {
        error:
          error instanceof AirtableReadError
            ? { code: error.code, message: error.message }
            : { code: "INTERNAL", message: "Error interno al leer Airtable." },
      };
    }
    await input.sandbox.writeTextFile({
      path: `${input.home}/rpc/${request.id}.json`,
      content: JSON.stringify(payload),
    });
  };
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
        throw new AirtableReadError(`Parámetros inválidos para airtable.records: ${parsed.error.message}`, {
          code: "INVALID_ARGUMENT",
        });
      }
      const { table, fields, formula, view, sort, max_records: maxRecords } = parsed.data;
      const schema = await gateway.resolveTable(table);
      const result = await gateway.listRecords({ table, fields, formula, view, sort, maxRecords });
      return {
        ...result,
        field_order: fields ?? schema.fields.map((field) => field.name),
      };
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

async function collectCharts(
  sandbox: CodeSandbox,
  charts: z.infer<typeof runnerDoneSchema>["charts"],
): Promise<ChartOutput[]> {
  const collected: ChartOutput[] = [];
  for (const chart of charts) {
    let bytes: Uint8Array | null = null;
    try {
      bytes = (await sandbox.readBinaryFile({ path: chart.path })) ?? null;
    } catch {
      bytes = null;
    }
    collected.push({
      id: chart.id,
      title: chart.title,
      mediaType: "image/png",
      path: chart.path,
      width: chart.width,
      height: chart.height,
      dataBase64:
        bytes !== null && bytes.byteLength <= MAX_CHART_BYTES
          ? Buffer.from(bytes).toString("base64")
          : null,
    });
  }
  return collected;
}

async function readLines(
  stream: ReadableStream<Uint8Array>,
  onLine: (line: string) => Promise<void>,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      await onLine(line);
      newline = buffer.indexOf("\n");
    }
  }
  buffer += decoder.decode();
  if (buffer !== "") await onLine(buffer);
}

async function readAll(stream: ReadableStream<Uint8Array>, limit: number): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (text.length < limit * 4) text += decoder.decode(value, { stream: true });
  }
  return text.length > limit ? `…${text.slice(-limit)}` : text;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}
