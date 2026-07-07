// Converts a plain JS value (built from a parsed JSON response, or from data
// the app itself constructs) into Clojure source text, so it can be spliced
// into a `repl.eval(...)` call. This is the return-trip counterpart to
// app.json/->json (doc/plan.md §7): that emits JSON strings out of a Repl,
// this turns them back into literal Clojure code the *other* Repl instance
// can eval directly -- no reader/EDN library needed on either side.
//
// Keywords need special handling: JSON has no keyword type, so app.json
// marks a keyword value by prefixing its JSON string form with the
// KEYWORD_MARKER sentinel (name only, colon added back here). Must match
// app.json/keyword-marker exactly. Plain ASCII, not a control character --
// a raw control byte embedded in a JSON string is illegal JSON and V8's
// JSON.parse rejects it (verified: an earlier control-character-based
// marker broke exactly this way once a real keyword-valued field, like a
// contract :type or :format tag, was involved).
const KEYWORD_MARKER = '~kw~';

export function toClojureString(s) {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n') + '"';
}

// cljrs-wasm's EvalResult.result() always applies pr-str to the evaluated
// value (verified: even when that value is already a Clojure string, e.g.
// our own app.json/->json output, result() pr-str's it *again*), so a
// string-returning eval needs one layer of Clojure string-literal escaping
// undone before it's ours to JSON.parse. Clojure's pr-str escapes \, ", and
// whitespace control chars but leaves other characters (like the keyword
// marker above) raw, so this only has to reverse that specific escaping.
export function unwrapClojureString(s) {
  if (s.length < 2 || s[0] !== '"' || s[s.length - 1] !== '"') {
    throw new Error('expected a pr-str\'d Clojure string, got: ' + s);
  }
  let out = '';
  for (let i = 1; i < s.length - 1; i++) {
    const c = s[i];
    if (c !== '\\') { out += c; continue; }
    const next = s[++i];
    out += next === 'n' ? '\n' : next === 't' ? '\t' : next === 'r' ? '\r' : next;
  }
  return out;
}

export function toEdn(value) {
  if (value === null || value === undefined) return 'nil';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') {
    return value.startsWith(KEYWORD_MARKER) ? ':' + value.slice(KEYWORD_MARKER.length) : toClojureString(value);
  }
  if (Array.isArray(value)) return '[' + value.map(toEdn).join(' ') + ']';
  if (typeof value === 'object') {
    const parts = Object.entries(value).map(([k, v]) => ':' + k + ' ' + toEdn(v));
    return '{' + parts.join(' ') + '}';
  }
  throw new Error('cannot serialize to Clojure source: ' + String(value));
}
