// Minimal in-memory Supabase query-builder fake so worker handlers can be tested
// without a live project: tables, filters, order/limit, single/maybeSingle,
// insert/update/upsert and rpc are all recorded for assertions.

function matchFilter(row, filter) {
  const { op, column, value } = filter;
  if (column === "or") {
    return String(value).split(",").some((part) => {
      const m = /^([a-z_]+)\.(eq|is)\.(.*)$/i.exec(part.trim());
      if (!m) return false;
      if (m[2].toLowerCase() === "is") {
        const v = m[3].trim();
        if (v === "null") return row[m[1]] === null || row[m[1]] === undefined;
        return String(row[m[1]]) === v;
      }
      return String(row[m[1]]) === m[3];
    });
  }
  const v = row[column];
  switch (op) {
    case "eq": return String(v) === String(value);
    case "neq": return String(v) !== String(value);
    case "in": return (value ?? []).map(String).includes(String(v));
    case "gte": return v !== null && v !== undefined && String(v) >= String(value);
    case "lt": return v !== null && v !== undefined && String(v) < String(value);
    default: return true;
  }
}

export function createFakeSupabase(seed = {}) {
  const tables = {};
  for (const [name, rows] of Object.entries(seed)) tables[name] = rows.map((r) => ({ ...r }));
  const log = { selects: [], inserts: [], updates: [], upserts: [], rpcs: [], deletes: [] };
  const rpcResults = new Map();

  function builder(table) {
    tables[table] ??= [];
    const state = { filters: [], order: null, limit: null, mode: "select", payload: null };
    const rows = () => (tables[table] ?? []).filter((r) => state.filters.every((f) => matchFilter(r, f)));

    function finish() {
      if (state.mode === "insert" || state.mode === "upsert") {
        const items = Array.isArray(state.payload) ? state.payload : [state.payload];
        const saved = [];
        for (const item of items) {
          const row = { id: item.id ?? `gen-${(tables[table] ?? []).length + 1}`, ...item };
          (tables[table] ??= []).push(row);
          saved.push(row);
        }
        log[state.mode === "insert" ? "inserts" : "upserts"].push({ table, rows: items });
        return { data: saved, error: null };
      }
      if (state.mode === "update") {
        const affected = rows();
        for (const row of affected) Object.assign(row, state.payload);
        log.updates.push({ table, values: state.payload, filters: state.filters });
        return { data: affected, error: null };
      }
      if (state.mode === "delete") {
        log.deletes.push({ table, filters: state.filters });
        return { data: [], error: null };
      }
      let out = rows();
      if (state.order) {
        const { column, ascending } = state.order;
        out = [...out].sort((a, b) => (String(a[column]) < String(b[column]) ? -1 : 1));
        if (!ascending) out.reverse();
      }
      if (state.limit) out = out.slice(0, state.limit);
      log.selects.push({ table, filters: state.filters });
      return { data: out, error: null };
    }

    const api = {
      select(columns) {
        if (columns && columns !== "*") log.selects.push({ table, columns });
        return api;
      },
      insert(payload) { state.mode = "insert"; state.payload = payload; return api; },
      upsert(payload) { state.mode = "upsert"; state.payload = payload; return api; },
      update(values) { state.mode = "update"; state.payload = values; return api; },
      delete() { state.mode = "delete"; return api; },
      eq(column, value) { state.filters.push({ op: "eq", column, value }); return api; },
      neq(column, value) { state.filters.push({ op: "neq", column, value }); return api; },
      in(column, value) { state.filters.push({ op: "in", column, value }); return api; },
      gte(column, value) { state.filters.push({ op: "gte", column, value }); return api; },
      lt(column, value) { state.filters.push({ op: "lt", column, value }); return api; },
      or(expression) { state.filters.push({ op: "or", column: "or", value: expression }); return api; },
      order(column, options = {}) {
        state.order = { column, ascending: options.ascending !== false };
        return api;
      },
      limit(n) { state.limit = n; return api; },
      maybeSingle() {
        const { data, error } = finish();
        return Promise.resolve({ data: Array.isArray(data) ? (data[0] ?? null) : data, error });
      },
      single() {
        const { data, error } = finish();
        const first = Array.isArray(data) ? data[0] : data;
        return Promise.resolve({ data: first ?? null, error: first ? null : { message: "not found" } });
      },
      then(resolve, reject) { return Promise.resolve(finish()).then(resolve, reject); },
    };
    return api;
  }

  return {
    tables, log,
    from: builder,
    async rpc(name, args) {
      log.rpcs.push({ name, args });
      if (rpcResults.has(name)) return { data: rpcResults.get(name), error: null };
      return { data: `job-${log.rpcs.length}`, error: null };
    },
    setRpcResult(name, value) { rpcResults.set(name, value); },
    rows(table) { return tables[table] ?? []; },
    sqlOf(entry) { return entry?.sql ?? ""; },
  };
}

// Fake pg pool: records every statement and pretends to be transactional.
export function createFakePool() {
  const statements = [];
  const client = {
    async query(text, params) {
      const sql = typeof text === "string" ? text : text?.text ?? "";
      statements.push({ sql, params: params ?? [] });
      return { rowCount: /^\s*delete/i.test(sql) ? 1 : 0, rows: [] };
    },
    release() {},
  };
  return {
    statements,
    async connect() { return client; },
  };
}
