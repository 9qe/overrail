// language: JavaScript (Node 18+ CommonJS), file: lib/recovery.js, target: overrail gateway
// Mid-stream tool-call recovery journal: append-only JSONL, metadata only.
// Hard boundary: this module can prove what the gateway EMITTED and what a cooperating
// client ACKED. It can never prove what the client EXECUTED — see docs/recovery-semantics.md.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { CONFIG_DIR } = require("./config");

const RECOVERY_FILENAME = "recovery.jsonl";
const RECOVERY_LOCK_SUFFIX = ".lock";
const JOURNAL_VERSION = 1;
const MAX_BODY_BYTES = 64 * 1024;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const HEADER_NAMES = ["idempotency-key", "overrail-recovery-key"];
// Append-only journals grow without a bound, so the append path compacts once the file
// crosses this ceiling (override with OVERRAIL_RECOVERY_MAX_BYTES).
const RECOVERY_MAX_BYTES = 8 * 1024 * 1024;
// A crashed process must not wedge the journal forever: a lock older than this is stolen.
const STALE_LOCK_MS = 5000;
// Every field the journal is allowed to contain. Anything not listed here is dropped
// before the line is written, so prompt text and tool arguments can never leak to disk.
const METADATA_FIELDS = [
  "recovery_id",
  "request_hash",
  "tool_call_id",
  "function",
  "args_sha256",
  "phase",
  "profile",
  "provider",
  "model",
  "source",
  "ts",
];
const CALL_PHASES = ["generated", "offered", "acknowledged", "abandoned"];
const RECORD_PHASES = ["created", ...CALL_PHASES];
// "offered" means the bytes were handed to the client; execution is then unknown,
// not pending — the client runs the tool outside this process.
const DELIVERED_PHASES = new Set(["offered", "acknowledged"]);

function sha256(text) {
  return crypto.createHash("sha256").update(String(text), "utf8").digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return value.map((item) => canonical(item === undefined ? null : item));
  if (value === null || typeof value !== "object") return value === undefined ? null : value;
  const ordered = {};
  for (const key of Object.keys(value).sort()) {
    if (value[key] === undefined) continue;
    ordered[key] = canonical(value[key]);
  }
  return ordered;
}

function canonical_json(value) {
  return JSON.stringify(canonical(value));
}

function as_text(value) {
  return typeof value === "string" ? value : value === null || value === undefined ? "" : String(value);
}

// Tool arguments are hashed after a JSON round-trip so {"a":1,"b":2} and {"b":2,"a":1}
// compare equal. Non-JSON payloads fall back to the trimmed string.
function normalize_arguments(args) {
  if (args === null || args === undefined) return "";
  if (typeof args === "object") return canonical_json(args);
  const text = String(args);
  try {
    return canonical_json(JSON.parse(text));
  } catch {
    return text.trim();
  }
}

function hash_arguments(args) {
  return sha256(`overrail-args:v1\n${normalize_arguments(args)}`);
}

function normalize_endpoint(endpoint) {
  return as_text(endpoint)
    .split("?")[0]
    .split("#")[0]
    .replace(/\/+$/, "");
}

const MESSAGE_FIELDS = ["role", "content", "name", "tool_call_id", "tool_calls", "prefix"];

// `index` is deliberately excluded: it is stream-framing noise that history messages may
// or may not carry, and array order already preserves position.
function normalize_tool_call(call) {
  if (!call || typeof call !== "object") return canonical(call);
  const fn = call.function && typeof call.function === "object" ? call.function : {};
  const out = {};
  if (call.id !== undefined && call.id !== null) out.id = call.id;
  if (call.type !== undefined && call.type !== null) out.type = call.type;
  out.function = { name: as_text(fn.name), arguments: normalize_arguments(fn.arguments) };
  return out;
}

function normalize_message(message) {
  if (!message || typeof message !== "object") return canonical(message);
  const out = {};
  for (const key of MESSAGE_FIELDS) {
    // a null field and an absent field are the same request (content: null is how
    // OpenAI-shaped clients spell "no text alongside the tool calls")
    if (message[key] === undefined || message[key] === null) continue;
    out[key] = key === "tool_calls" && Array.isArray(message[key])
      ? message[key].map(normalize_tool_call)
      : canonical(message[key]);
  }
  if (out.role !== undefined) out.role = as_text(out.role).trim();
  return out;
}

// Tool definitions are order-significant for the model, so the array order is preserved
// while each entry is canonicalized field-by-field.
function normalize_tools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools.map((tool) => {
    if (!tool || typeof tool !== "object") return canonical(tool);
    const fn = tool.function && typeof tool.function === "object" ? tool.function : {};
    return {
      type: tool.type === undefined ? null : tool.type,
      function: {
        name: as_text(fn.name),
        description: fn.description === undefined ? null : as_text(fn.description),
        parameters: fn.parameters === undefined ? null : canonical(fn.parameters),
      },
    };
  });
}

function normalize_tool_results(tool_results) {
  if (!Array.isArray(tool_results)) return [];
  return tool_results.map(normalize_message);
}

function header_value(headers, names) {
  if (!headers) return null;
  const lookup =
    typeof headers.get === "function"
      ? (name) => headers.get(name)
      : (name) => {
          for (const [key, value] of Object.entries(headers)) {
            if (String(key).toLowerCase() === name) return value;
          }
          return undefined;
        };
  for (const name of names) {
    const value = lookup(name);
    if (typeof value === "string" && value.trim() !== "") return value.trim();
    if (Array.isArray(value) && value.length > 0 && typeof value[0] === "string" && value[0].trim() !== "") {
      return value[0].trim();
    }
  }
  return null;
}

function normalized_request(request) {
  const normalized = {
    endpoint: normalize_endpoint(request.endpoint),
    profile_name: as_text(request.profile_name).trim(),
    model: as_text(request.model).trim(),
    messages: Array.isArray(request.messages) ? request.messages.map(normalize_message) : [],
    tools: normalize_tools(request.tools),
    tool_results: normalize_tool_results(request.tool_results),
  };
  // Generation parameters decide what the model produces, so two requests that differ only
  // in temperature/max_tokens/stop are logically different and must not share one identity.
  // Not allowlisted: whatever object the caller sends is folded in. It reaches the digest
  // only — metadata_only() never persists these values to disk. Absent params => v1 shape.
  if (request.params && typeof request.params === "object" && !Array.isArray(request.params)) {
    normalized.params = canonical(request.params);
  }
  return normalized;
}

// Stable recovery identity for one logical request. A caller-supplied key wins; without
// one the identity is the deterministic digest of the normalized request, so a retried
// request lands on the same session instead of forking a second journal entry.
function derive_recovery_key(request = {}) {
  const normalized = normalized_request(request);
  // v2 folds generation params into the identity; the prefix bump ensures old journal
  // lines (v1, params-blind) can never be mistaken for new-format identities.
  const request_hash = sha256(`overrail-request:v2\n${canonical_json(normalized)}`);
  const supplied = header_value(request.headers, HEADER_NAMES);
  if (supplied) {
    // the raw caller key never leaves this function — only its digest becomes the id
    return {
      recovery_id: sha256(`overrail-recovery-key:v1\n${supplied}`),
      request_hash,
      source: "header",
    };
  }
  return { recovery_id: request_hash, request_hash, source: "derived" };
}

function journal_path() {
  return path.join(process.env.OVERRAIL_RECOVERY_DIR || CONFIG_DIR, RECOVERY_FILENAME);
}

function metadata_only(record) {
  const out = { v: JOURNAL_VERSION };
  for (const key of METADATA_FIELDS) {
    const value = record[key];
    // only strings are ever written, and every field is allowlisted: an object carrying
    // prompt or argument content cannot survive this filter
    if (typeof value !== "string" || value === "") continue;
    if (key === "phase" && !RECORD_PHASES.includes(value)) continue;
    out[key] = value.slice(0, 256);
  }
  return out;
}

function append_journal(record) {
  const line = metadata_only(record);
  if (!line.recovery_id) return { ok: false, code: "missing_recovery_id" };
  const file = journal_path();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Single short line per append: O_APPEND keeps concurrent legs from interleaving
  // inside a line; a torn tail is tolerated by read_journal and skipped here.
  fs.appendFileSync(file, `${JSON.stringify(line)}\n`);
  // Best-effort growth bound: compact once the file crosses the ceiling. compact_journal
  // no-ops when the lock is held elsewhere, so this never wedges the append path.
  let size = 0;
  try {
    size = fs.statSync(file).size;
  } catch {}
  if (size > max_journal_bytes()) compact_journal();
  return { ok: true, record: line };
}

function read_journal(limit = 10000) {
  let raw;
  try {
    raw = fs.readFileSync(journal_path(), "utf8");
  } catch {
    return [];
  }
  const entries = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed) && parsed.recovery_id) {
        entries.push(parsed);
      }
    } catch {
      // torn or corrupt line — skip it
    }
  }
  return limit > 0 ? entries.slice(-limit) : entries;
}

function valid_recovery_id(recovery_id) {
  return typeof recovery_id === "string" && ID_PATTERN.test(recovery_id);
}

// Provider tool-call ids are short opaque tokens. Anything with whitespace or a control
// character is prompt-shaped garbage: refuse it rather than persist it.
function valid_tool_call_id(tool_call_id) {
  return (
    typeof tool_call_id === "string" &&
    tool_call_id.length > 0 &&
    tool_call_id.length <= 128 &&
    !/[\s\u0000-\u001f\u007f]/.test(tool_call_id)
  );
}

function session_records(recovery_id) {
  return read_journal(0).filter((entry) => entry.recovery_id === recovery_id);
}

function empty_state(recovery_id) {
  return {
    recovery_id,
    exists: false,
    request_hash: null,
    profile: null,
    provider: null,
    model: null,
    source: null,
    created_ts: null,
    calls: {},
    order: [],
  };
}

function build_state(recovery_id, records) {
  const state = empty_state(recovery_id);
  if (records.length === 0) return state;
  state.exists = true;
  let creation_seen = false;
  for (const record of records) {
    if (record.phase === "created") {
      if (!creation_seen) {
        state.created_ts = record.ts || null;
        state.source = record.source || state.source;
        creation_seen = true;
      }
      if (record.request_hash) state.request_hash = record.request_hash;
      if (record.profile) state.profile = record.profile;
      if (record.provider) state.provider = record.provider;
      if (record.model) state.model = record.model;
      continue;
    }
    if (!record.tool_call_id) continue;
    const id = record.tool_call_id;
    if (!state.calls[id]) {
      state.calls[id] = {
        tool_call_id: id,
        function: null,
        args_sha256: null,
        status: null,
        delivered: false,
        phases: [],
      };
      state.order.push(id);
    }
    const call = state.calls[id];
    call.phases.push(record.phase);
    if (record.function) call.function = record.function;
    if (record.args_sha256) call.args_sha256 = record.args_sha256;
    if (record.provider) state.provider = record.provider;
    if (DELIVERED_PHASES.has(record.phase)) call.delivered = true;
    // acknowledged absorbs every later transition: once a client reports the side
    // effect happened, no regeneration note can walk that fact back.
    if (call.status !== "acknowledged") call.status = record.phase;
    else if (record.phase === "abandoned") call.conflict = "acknowledged_wins_over_abandon";
  }
  if (!state.created_ts) {
    state.created_ts = records[0].ts || null;
    state.source = records[0].source || null;
  }
  if (!state.request_hash) {
    const with_hash = records.find((entry) => entry.request_hash);
    if (with_hash) state.request_hash = with_hash.request_hash;
  }
  return state;
}

function load_state(recovery_id) {
  if (!valid_recovery_id(recovery_id)) return empty_state(recovery_id);
  return build_state(recovery_id, session_records(recovery_id));
}

function max_journal_bytes() {
  const raw = process.env.OVERRAIL_RECOVERY_MAX_BYTES;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : RECOVERY_MAX_BYTES;
}

function journal_lock_path() {
  return `${journal_path()}${RECOVERY_LOCK_SUFFIX}`;
}

// Best-effort exclusive lock around compaction only (appends stay single atomic writes).
// A "wx" create is atomic across processes, so exactly one contender wins; a lock whose
// mtime is older than STALE_LOCK_MS belongs to a crashed process and is stolen so the
// journal can never be wedged forever. Returns the lock path if we own it, else null.
function acquire_compact_lock() {
  const lock = journal_lock_path();
  try {
    fs.mkdirSync(path.dirname(lock), { recursive: true });
  } catch {}
  for (let attempt = 0; attempt < 3; attempt++) {
    let fd;
    try {
      fd = fs.openSync(lock, "wx");
    } catch (err) {
      if (!err || err.code !== "EEXIST") return null; // unexpected error: bail, keep any lock
      let mtime = null;
      try {
        mtime = fs.statSync(lock).mtimeMs;
      } catch {
        mtime = null;
      }
      if (mtime === null || Date.now() - mtime > STALE_LOCK_MS) {
        try {
          fs.unlinkSync(lock);
        } catch {}
        continue; // stale (or unreadable) lock — retry the create
      }
      return null; // a fresh lock is held elsewhere: skip rather than corrupt
    }
    try {
      fs.writeSync(fd, String(process.pid));
    } finally {
      fs.closeSync(fd);
    }
    return lock;
  }
  return null;
}

function release_compact_lock(lock) {
  try {
    fs.unlinkSync(lock);
  } catch {}
}

// Collapse every tool-call phase sequence down to the records that still reconstruct the
// session's current state (status/delivered/conflict/function/args + session fields),
// leaving the "created" line and each call's terminal record(s) in place. Idempotent.
function compact_journal() {
  const lock = acquire_compact_lock();
  if (!lock) return { ok: false, code: "compact_lock_busy" };
  try {
    const records = read_journal(0);
    if (records.length === 0) return { ok: true, before: 0, after: 0, removed: 0 };

    const keep = new Set();
    const sessions = new Map();
    records.forEach((record, index) => {
      if (!record.recovery_id) return;
      let session = sessions.get(record.recovery_id);
      if (!session) {
        session = { first_index: index, has_created: false, groups: new Map() };
        sessions.set(record.recovery_id, session);
      }
      if (record.phase === "created") {
        // session-level record: it carries request_hash/profile/provider/model/source/ts,
        // so it is always retained (this is also the "any session-level record carrying its
        // request_hash" clause of the compaction contract).
        session.has_created = true;
        keep.add(index);
        return;
      }
      if (record.tool_call_id && CALL_PHASES.includes(record.phase)) {
        let group = session.groups.get(record.tool_call_id);
        if (!group) {
          group = [];
          session.groups.set(record.tool_call_id, group);
        }
        group.push({ record, index });
      }
    });

    for (const session of sessions.values()) {
      // a session with no "created" line (raw journal writers do this) still needs its
      // first record so build_state's created_ts/source fallback survives; and every call
      // group keeps its terminal record(s).
      if (!session.has_created) keep.add(session.first_index);
      for (const group of session.groups.values()) {
        for (const index of collapse_group(group)) keep.add(index);
      }
    }

    const compacted = records.filter((_record, index) => keep.has(index));
    const file = journal_path();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // Write to a temp file in the same directory and rename over the original: a crash
    // mid-write leaves the intact journal, never a truncated one. rename is atomic on the
    // same filesystem, so readers only ever see the whole old file or the whole new file.
    const temp = `${file}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`;
    const body = compacted.map((record) => JSON.stringify(record)).join("\n");
    fs.writeFileSync(temp, body === "" ? "" : `${body}\n`);
    fs.renameSync(temp, file);
    return { ok: true, before: records.length, after: compacted.length, removed: records.length - compacted.length };
  } finally {
    release_compact_lock(lock);
  }
}

// Given one (recovery_id, tool_call_id) phase sequence, return the original record indices
// to retain so build_state reproduces the same status/delivered/conflict/function/args,
// while dropping redundant intermediate transitions. Order of first appearance is held by
// always keeping the group's first record; the terminal record carries the final fields.
function collapse_group(group) {
  const phases = group.map((entry) => entry.record.phase);
  const last_index = group.length - 1;
  const kept = new Set([0, last_index]);

  const delivered_target = phases.some((phase) => DELIVERED_PHASES.has(phase));
  const first_ack = phases.indexOf("acknowledged");
  const last_ack = phases.lastIndexOf("acknowledged");
  const status_target = first_ack !== -1 ? "acknowledged" : phases[last_index];
  // build_state flags conflict only when an abandoned lands after the status is already
  // acknowledged; mirror that condition rather than guessing it.
  let conflict_target = false;
  if (first_ack !== -1) {
    for (let i = first_ack + 1; i < phases.length; i++) {
      if (phases[i] === "abandoned") {
        conflict_target = true;
        break;
      }
    }
  }

  if (status_target === "acknowledged") {
    kept.add(last_ack);
    if (conflict_target) {
      kept.add(first_ack);
      for (let i = first_ack + 1; i < phases.length; i++) {
        if (phases[i] === "abandoned") {
          kept.add(i);
          break;
        }
      }
    }
  }
  // A single delivered record (offered or acknowledged) is enough to set the delivered flag.
  if (delivered_target) {
    for (let i = last_index; i >= 0; i--) {
      if (DELIVERED_PHASES.has(phases[i])) {
        kept.add(i);
        break;
      }
    }
  }
  return [...kept].sort((a, b) => a - b).map((position) => group[position].index);
}

// A session is created once per recovery_id. Re-creating it with the same request hash
// is a no-op (mid-stream legs call this repeatedly); the same id carrying a different
// request hash is a caller bug — a reused idempotency key — and is refused, not merged.
function create_session(input = {}) {
  const recovery_id = input.recovery_id;
  if (!valid_recovery_id(recovery_id)) {
    return { ok: false, code: "invalid_recovery_id", recovery_id: recovery_id ?? null };
  }
  const existing = load_state(recovery_id);
  if (existing.exists) {
    if (input.request_hash && existing.request_hash && input.request_hash !== existing.request_hash) {
      return {
        ok: false,
        code: "idempotency_key_conflict",
        recovery_id,
        existing_request_hash: existing.request_hash,
        request_hash: input.request_hash,
      };
    }
    return { ok: true, created: false, state: existing };
  }
  const record = {
    ts: new Date().toISOString(),
    recovery_id,
    request_hash: input.request_hash || null,
    phase: "created",
    profile: input.profile || input.profile_name || null,
    provider: input.provider || null,
    model: input.model || null,
    source: input.source || null,
  };
  append_journal(record);
  return { ok: true, created: true, state: load_state(recovery_id), record };
}

// One-call front door for the gateway: derive the identity from the request, then open
// or reuse the session. Returns the same ok/code shape as create_session.
function open_session(request = {}) {
  const key = derive_recovery_key(request);
  // A caller-supplied key can legitimately carry different bodies. Surface a reused-key /
  // mismatched-hash conflict at request time — before any append — so the gateway can reject
  // it rather than discovering it late via record_emitted_calls. Derived ids skip this: the
  // id IS the request hash there, so same key means same request by construction.
  if (key.source === "header") {
    const existing = load_state(key.recovery_id);
    if (existing.exists && existing.request_hash && existing.request_hash !== key.request_hash) {
      return {
        ok: false,
        code: "idempotency_key_conflict",
        recovery_id: key.recovery_id,
        request_hash: key.request_hash,
        existing_request_hash: existing.request_hash,
        source: key.source,
        created: false,
        state: null,
      };
    }
  }
  const result = create_session({
    recovery_id: key.recovery_id,
    request_hash: key.request_hash,
    profile: request.profile_name,
    model: request.model,
    provider: request.provider,
    source: key.source,
  });
  return {
    recovery_id: key.recovery_id,
    request_hash: key.request_hash,
    source: key.source,
    ok: result.ok,
    created: result.created === true,
    code: result.code,
    state: result.state || null,
    // create_session can also raise the conflict (e.g. a racing creation); pass the
    // incumbent hash through so the gateway sees the same shape either way.
    ...(result.existing_request_hash ? { existing_request_hash: result.existing_request_hash } : {}),
  };
}

// phase "generated": the call exists in gateway memory only and never reached the wire.
// phase "offered": the gateway forwarded the completed call to the client.
function record_tool_call(input = {}) {
  const recovery_id = input.recovery_id;
  if (!valid_recovery_id(recovery_id)) return { ok: false, code: "invalid_recovery_id" };
  const tool_call_id = as_text(input.tool_call_id).trim();
  if (!valid_tool_call_id(tool_call_id)) return { ok: false, code: "invalid_tool_call_id" };
  const phase = input.phase === undefined ? "offered" : input.phase;
  if (phase !== "generated" && phase !== "offered") {
    return { ok: false, code: "invalid_phase", phase };
  }
  const session = load_state(recovery_id);
  if (!session.exists) return { ok: false, code: "unknown_recovery_id", recovery_id };

  const name = as_text(input.name || input.function_name).trim();
  const args_sha256 = hash_arguments(input.arguments);
  const existing = session.calls[tool_call_id];
  if (existing && existing.status === "acknowledged") {
    // The client already reported this call executed. Re-recording it is the duplicate
    // side-effect signal the docs promise to surface, so it is reported, not hidden.
    return {
      ok: true,
      deduped: true,
      conflict: "already_executed",
      recovery_id,
      tool_call_id,
      args_sha256,
      status: "acknowledged",
    };
  }
  if (existing && existing.phases.includes(phase) && existing.args_sha256 === args_sha256) {
    return { ok: true, deduped: true, conflict: null, recovery_id, tool_call_id, args_sha256, status: existing.status };
  }
  append_journal({
    ts: new Date().toISOString(),
    recovery_id,
    request_hash: input.request_hash || session.request_hash || null,
    tool_call_id,
    function: name === "" ? null : name,
    args_sha256,
    phase,
    profile: input.profile || input.profile_name || session.profile,
    provider: input.provider || session.provider,
  });
  const updated = load_state(recovery_id).calls[tool_call_id];
  return {
    ok: true,
    deduped: false,
    conflict: null,
    recovery_id,
    tool_call_id,
    args_sha256,
    status: updated ? updated.status : phase,
  };
}

// Batch helper for the relay, which holds OpenAI-shaped tool_call objects in memory:
// phase "offered" for calls actually forwarded, "generated" for buffers that died with
// the dropped leg.
function record_emitted_calls(input = {}) {
  const calls = Array.isArray(input.calls) ? input.calls : [];
  return calls.map((call) =>
    record_tool_call({
      recovery_id: input.recovery_id,
      tool_call_id: call && call.id,
      name: call && call.function && call.function.name,
      arguments: call && call.function && call.function.arguments,
      phase: input.phase,
      profile: input.profile,
      provider: input.provider,
      request_hash: input.request_hash,
    })
  );
}

// The only transition the client is allowed to assert. Idempotent by design: a retried
// acknowledgement reports replay instead of writing a second execution record.
function acknowledge_execution(input = {}) {
  const recovery_id = input.recovery_id;
  if (!valid_recovery_id(recovery_id)) return { ok: false, code: "invalid_recovery_id" };
  const tool_call_id = as_text(input.tool_call_id).trim();
  const session = load_state(recovery_id);
  if (!session.exists) return { ok: false, code: "unknown_recovery_id", recovery_id };
  if (tool_call_id === "") return { ok: false, code: "invalid_tool_call_id", recovery_id };
  const call = session.calls[tool_call_id];
  if (!call) return { ok: false, code: "unknown_tool_call_id", recovery_id, tool_call_id };
  if (call.status === "acknowledged") {
    return {
      ok: true,
      replay: true,
      recovery_id,
      tool_call_id,
      status: "acknowledged",
      args_sha256: call.args_sha256,
      function: call.function,
    };
  }
  const was = call.status;
  append_journal({
    ts: new Date().toISOString(),
    recovery_id,
    request_hash: session.request_hash,
    tool_call_id,
    function: call.function,
    args_sha256: call.args_sha256,
    phase: "acknowledged",
    profile: session.profile,
    provider: input.provider || session.provider,
  });
  return {
    ok: true,
    replay: false,
    recovery_id,
    tool_call_id,
    status: "acknowledged",
    args_sha256: call.args_sha256,
    function: call.function,
    // An ack that arrives after abandonment means the client ran a call the gateway
    // already told the next leg to regenerate. Truthfully recorded, flagged for the caller.
    ...(was === "abandoned" ? { was: "abandoned", conflict: "duplicate_side_effect_risk" } : {}),
  };
}

function abandon_call(input = {}) {
  const recovery_id = input.recovery_id;
  if (!valid_recovery_id(recovery_id)) return { ok: false, code: "invalid_recovery_id" };
  const tool_call_id = as_text(input.tool_call_id).trim();
  const session = load_state(recovery_id);
  if (!session.exists) return { ok: false, code: "unknown_recovery_id", recovery_id };
  const call = session.calls[tool_call_id];
  if (!call) return { ok: false, code: "unknown_tool_call_id", recovery_id, tool_call_id };
  if (call.status === "acknowledged") {
    return { ok: true, deduped: true, recovery_id, tool_call_id, status: "acknowledged", conflict: "already_executed" };
  }
  if (call.status === "abandoned") {
    return { ok: true, deduped: true, recovery_id, tool_call_id, status: "abandoned", conflict: null };
  }
  append_journal({
    ts: new Date().toISOString(),
    recovery_id,
    request_hash: session.request_hash,
    tool_call_id,
    function: call.function,
    args_sha256: call.args_sha256,
    phase: "abandoned",
    profile: session.profile,
    provider: session.provider,
  });
  return { ok: true, deduped: false, recovery_id, tool_call_id, status: "abandoned", conflict: null };
}

function is_executed(recovery_id, tool_call_id) {
  const state = load_state(recovery_id);
  const call = state.calls[tool_call_id];
  return Boolean(call && call.status === "acknowledged");
}

// Arguments are deliberately not persisted, so a stitched continuation cannot quote them
// back. When the caller still holds them in memory (the relay does), pass known_arguments
// and they are used; otherwise this valid-JSON sentinel names the gap instead of inventing
// arguments.
const ARGS_UNAVAILABLE = (args_sha256) =>
  JSON.stringify({ _overrail_recovery: "arguments_not_persisted", args_sha256: args_sha256 || null });

function continuation_history(recovery_id, options = {}) {
  const state = load_state(recovery_id);
  const known = options.known_arguments && typeof options.known_arguments === "object" ? options.known_arguments : {};
  const assistant_content = typeof options.assistant_content === "string" ? options.assistant_content : null;
  const acknowledged = [];
  const delivered_unacknowledged = [];
  const generated_unacknowledged = [];
  const abandoned = [];
  for (const tool_call_id of state.order) {
    const call = state.calls[tool_call_id];
    const summary = {
      tool_call_id,
      function: call.function,
      args_sha256: call.args_sha256,
      status: call.status,
      delivered: call.delivered,
    };
    if (call.status === "acknowledged") acknowledged.push({ ...summary, executed: true });
    else if (call.status === "abandoned") abandoned.push(summary);
    else if (call.status === "offered") delivered_unacknowledged.push(summary);
    else generated_unacknowledged.push(summary);
  }
  // abandoned calls split by delivery: never-delivered ones are safe to regenerate,
  // delivered ones carry the same unknown side-effect state as any unacknowledged offer
  const regen = [...generated_unacknowledged, ...abandoned.filter((call) => !call.delivered)];
  const unknown_side_effects = [...delivered_unacknowledged, ...abandoned.filter((call) => call.delivered)];

  const TOOL_RESULTS = {
    executed: "[overrail recovery] the client acknowledged this call as executed. Do not repeat it.",
    unconfirmed:
      "[overrail recovery] this call was delivered to the client but never acknowledged. Whether the side effect happened is unknown — do not assume it ran and do not repeat it.",
    abandoned:
      "[overrail recovery] this call was delivered and then abandoned without an acknowledgement. Side-effect state unknown.",
  };
  const resolve_arguments = (call) =>
    Object.prototype.hasOwnProperty.call(known, call.tool_call_id)
      ? normalize_arguments(known[call.tool_call_id])
      : ARGS_UNAVAILABLE(call.args_sha256);

  const messages = [];
  // every delivered call belongs in the conversation history — the client saw it; whether
  // it *ran* is a separate fact, carried by the tool result text instead of being faked
  const delivered = state.order
    .map((tool_call_id) => state.calls[tool_call_id])
    .filter((call) => call.delivered)
    .map((call) => ({
      call,
      kind:
        call.status === "acknowledged"
          ? "executed"
          : call.status === "abandoned"
            ? "abandoned"
            : "unconfirmed",
    }));
  if (delivered.length > 0) {
    messages.push({
      role: "assistant",
      content: assistant_content || null,
      tool_calls: delivered.map(({ call }) => ({
        id: call.tool_call_id,
        type: "function",
        function: { name: call.function || "unknown", arguments: resolve_arguments(call) },
      })),
    });
    for (const { call, kind } of delivered) {
      messages.push({ role: "tool", tool_call_id: call.tool_call_id, content: TOOL_RESULTS[kind] });
    }
  }

  const describe = (group) => group.map((call) => `${call.function || "unknown"}(${call.tool_call_id})`).join(", ");
  const directives = [];
  if (unknown_side_effects.length > 0) {
    directives.push(
      `Delivered but never acknowledged — side-effect state unknown, do not assume it ran and do not repeat it: ${describe(unknown_side_effects)}.`
    );
  }
  if (regen.length > 0) {
    directives.push(
      `Generated by the gateway but never delivered to the client — regenerate these calls: ${describe(regen)}.`
    );
  }
  if (directives.length > 0) {
    messages.push({ role: "user", content: `[overrail recovery]\n${directives.join("\n")}` });
  }

  return {
    recovery_id,
    exists: state.exists,
    request_hash: state.request_hash,
    acknowledged,
    delivered_unacknowledged,
    generated_unacknowledged,
    abandoned,
    must_regenerate: regen.map((call) => call.tool_call_id),
    execution_unknown: unknown_side_effects.map((call) => call.tool_call_id),
    executed: acknowledged.map((call) => call.tool_call_id),
    arguments_persisted: false,
    messages,
  };
}

function send_json(res, status, payload, extra_headers = {}) {
  res.writeHead(status, { "content-type": "application/json", ...extra_headers });
  res.end(JSON.stringify(payload));
}

function read_body(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// POST /v1/recovery/:id/ack  body { "tool_call_id": "call_..." }
// Standalone handler: route it yourself (match_recovery_ack + call this). Never throws;
// unknown ids and replays come back as JSON error/replay shapes.
async function handle_recovery_ack(req, res, recovery_id) {
  try {
    if (req.method !== "POST") {
      return send_json(res, 405, { error: { message: "method must be POST", code: "method_not_allowed" } }, {
        allow: "POST",
      });
    }
    if (!valid_recovery_id(recovery_id)) {
      return send_json(res, 400, {
        error: { message: "recovery id must match ^[A-Za-z0-9_-]{1,128}$", code: "invalid_recovery_id" },
      });
    }
    let raw;
    try {
      raw = await read_body(req);
    } catch (err) {
      return send_json(res, 400, {
        error: { message: `could not read request body (${err.message})`, code: "unreadable_body" },
      });
    }
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return send_json(res, 400, { error: { message: "request body is not valid JSON", code: "invalid_json" } });
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return send_json(res, 400, {
        error: { message: 'request body must be a JSON object with a "tool_call_id" field', code: "invalid_body" },
      });
    }
    const tool_call_id = as_text(parsed.tool_call_id).trim();
    if (tool_call_id === "") {
      return send_json(res, 400, {
        error: { message: 'missing or empty "tool_call_id"', code: "missing_tool_call_id" },
      });
    }
    const state = load_state(recovery_id);
    if (!state.exists) {
      return send_json(res, 404, {
        error: { message: `unknown recovery id "${recovery_id}"`, code: "unknown_recovery_id" },
      });
    }
    if (!state.calls[tool_call_id]) {
      return send_json(res, 404, {
        error: {
          message: `recovery "${recovery_id}" has no tool call "${tool_call_id}"`,
          code: "unknown_tool_call_id",
        },
      });
    }
    const result = acknowledge_execution({
      recovery_id,
      tool_call_id,
      provider: typeof parsed.provider === "string" ? parsed.provider.slice(0, 64) : null,
    });
    if (!result.ok) {
      const status = result.code === "unknown_recovery_id" || result.code === "unknown_tool_call_id" ? 404 : 400;
      return send_json(res, status, { error: { message: result.code, code: result.code } });
    }
    return send_json(res, 200, {
      object: "overrail.recovery.ack",
      recovery_id,
      tool_call_id,
      status: result.status,
      replay: result.replay === true,
      executed_once_claim: "client-asserted only; the gateway cannot observe execution",
      ...(result.was ? { was: result.was } : {}),
      ...(result.conflict ? { conflict: result.conflict } : {}),
    });
  } catch (err) {
    if (!res.headersSent) {
      return send_json(res, 500, {
        error: { message: (err && err.message) || "recovery ack failed", code: "recovery_ack_error" },
      });
    }
    try {
      res.destroy();
    } catch {}
  }
}

function match_recovery_ack(pathname) {
  const match = /^\/v1\/recovery\/([^/?#]+)\/ack\/?$/.exec(as_text(pathname));
  if (!match) return null;
  let recovery_id = match[1];
  try {
    recovery_id = decodeURIComponent(recovery_id);
  } catch {}
  return { recovery_id };
}

module.exports = {
  RECOVERY_FILENAME,
  RECOVERY_LOCK_SUFFIX,
  RECOVERY_MAX_BYTES,
  STALE_LOCK_MS,
  HEADER_NAMES,
  CALL_PHASES,
  RECORD_PHASES,
  journal_path,
  journal_lock_path,
  max_journal_bytes,
  compact_journal,
  read_journal,
  valid_recovery_id,
  hash_arguments,
  normalize_arguments,
  canonical_json,
  derive_recovery_key,
  create_session,
  open_session,
  record_tool_call,
  record_emitted_calls,
  acknowledge_execution,
  abandon_call,
  is_executed,
  load_state,
  continuation_history,
  handle_recovery_ack,
  match_recovery_ack,
};
