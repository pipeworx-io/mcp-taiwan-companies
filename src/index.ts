interface McpToolDefinition {
  name: string;
  description: string;
  /** Human-facing one-liner (fleet #1967). Optional; consumers fall back to
   *  description. Kept in step with shared/src/types.ts — scripts/lib/
   *  check-inlined-types.mjs reports drift at publish time. */
  summary?: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    anyOf?: Array<{ required: string[] }>;
    oneOf?: Array<{ required: string[] }>;
    allOf?: Array<{ required: string[] }>;
  };
  outputSchema?: Record<string, unknown>;
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Was this failure OUR OWN web service? — the other half of `internal-db-class.ts`.
 *
 * fleet #1089 pulled failures from our own Postgres out of `upstream_down` by
 * keying on the SQLSTATE inside PostgREST's four-key error envelope. That
 * covered the majority and structurally could not cover the rest: the rest
 * never reach Postgres, so they carry no SQLSTATE. What was left, measured over
 * the 24h to 2026-09-02T15:00Z (fleet #1096):
 *
 *     5  pipeworx-catalog  get_pack_tools     Pipeworx catalog error: 522 — error code: 522
 *     3  fleet             fleet_list_open …  upstream_down: Fleet task queue did not respond within 25s
 *
 * 521/522/523/526 are Cloudflare saying its edge could not reach an ORIGIN, and
 * in both of those rows the origin is ours — `gateway.pipeworx.io` for the
 * catalog pack (it self-fetches when the gateway hasn't injected a manifest),
 * our own Supabase for fleet. There is no third party anywhere in either call.
 * Same defect as #1089: our own outage filed under `upstream_down`, the one
 * class that means "the source is unreachable and there is nothing for us to
 * fix", which is why the problem-tools triage skips it.
 *
 * WHY NOT A WORDING RULE. The obvious fix is to match `fleet db error:` and
 * `Pipeworx catalog error:` in classifyToolError. Each is emitted from exactly
 * one site today, so it would work today. It would also rot the first time
 * somebody rewords a label — silently, and in the direction of hiding our own
 * outage, which is worse than the bug being fixed. Every prose rule in
 * error-class.ts has needed widening as packs invented new wording (#409/#450/
 * #584); that history is most of that file's comment budget.
 *
 * WHAT THIS KEYS ON INSTEAD: **the host the call actually reached.** A URL's
 * hostname is a fact about the call, not a guess about its prose. Two
 * consequences that a pack-level flag could not give us, and the reason the
 * flag was rejected:
 *
 *   - It describes the CALL, not the pack. `govcon-intel` fans out to our own
 *     Supabase AND to genuine third parties; `court-listener` holds our cache
 *     in Supabase and fetches courtlistener.com. An `internallyHosted: true` on
 *     either pack would relabel a real third-party outage as ours — inventing
 *     work, which is the same class of error in the opposite direction.
 *   - It covers every future internal pack for free, instead of one declared
 *     slug at a time.
 *
 * WHY IT SURVIVES A REWORD. The marker below is not matched as a literal by two
 * separate files. `markInternalOrigin()` writes it and `internalHostMetricsClass()`
 * reads it, both from the single exported `INTERNAL_ORIGIN_MARKER` constant in
 * this module — so changing the wording changes both sides in the same edit and
 * cannot desynchronise them. The pack's own label (`fleet db error:`,
 * `Pipeworx catalog error:`) is not read at all: reword it freely, the class is
 * unaffected. That is the property `stripClassPrefix` lacked when it drifted
 * from its own classifier three times and needed a CI gate to hold them
 * together.
 *
 * WHERE THE 5xx TEST LIVES. `markInternalOrigin` is called from the places that
 * hold the real `Response` — `httpError`/`httpErrorMessage` and the timeout
 * branch of `fetchWithTimeout` in `shared/src/http.ts` — so "is this an
 * availability failure" is decided from the actual status code, never re-derived
 * by scraping a number out of a sentence. A 404 from our own registry for a slug
 * that does not exist is a caller's bad argument and is deliberately NOT marked.
 */

/**
 * OUR OWN web service was unreachable — not an upstream, and never `upstream_down`.
 *
 * ONE value, not three, unlike `internal_db_*`. That split existed because a
 * slow query, an exhausted pool and an unknown SQLSTATE have different owners
 * and different fixes. Here there is only one story to tell — an origin we run
 * did not answer the edge — and one owner. A bucket with no distinct owner per
 * value is decoration; #724 is what happens when a class holds several
 * situations, and inventing sub-values ahead of a reason to act on them
 * differently is the same mistake with the sign flipped.
 *
 * METRICS ONLY, exactly like PLATFORM_KEY_ERROR_CLASS and the internal_db
 * values. `classifyToolError` still answers `upstream_down` for the retry and
 * hint paths, which only care whether retrying or a sibling tool might work —
 * and it might. Nothing a caller sees or is charged changes here.
 *
 * READ SIDE: this value is in BROKEN_TOOL_CLASSES, FAULT_CLASSES and
 * ALL_ERROR_CLASSES in `workers/registry-api/src/index.ts`. All three, or it
 * lands on no dashboard — fleet #721 is the warning, where the #719 split
 * worked on the write side and was invisible for weeks.
 */
const INTERNAL_SERVICE_UNREACHABLE_CLASS = 'internal_service_unreachable';

/**
 * The token that carries "this origin is ours" from the call site to the
 * classifier.
 *
 * Appended to the error message rather than attached to the Error object,
 * because the object does not survive the trip: 275 packs return `{ error:
 * string }` instead of throwing, the gateway reads `observedError` as a string,
 * and the fleet pack rebuilds its error from a captured status + body across a
 * retry loop. A property on an Error would be dropped by every one of those
 * paths and the class would work in tests and vanish in production.
 *
 * WORDING IS LOAD-BEARING, same rule as labelAge's note in authority.ts. This
 * string is appended to a pack's thrown Error message (shared/src/http.ts),
 * and a thrown Error's message is exactly what the gateway hands back to the
 * caller as `content[0].text` when nothing rewrites it (workers/gateway/src
 * catches the throw and sets `rawResult.message = stripClassPrefix(error)`,
 * which does not touch this suffix) — so the original wording,
 * " [pipeworx-hosted origin — our own service, not a third party]", was not a
 * theoretical leak: it shipped live on pipeworx-catalog's 522s, 7 times in 6
 * hours on 2026-09-02 (see tests/golden-internal-service.test.ts), verbatim
 * naming Pipeworx as the host. check:hosting-claims never caught it because it
 * did not scan shared/ at all (task #2009). Reworded to describe the
 * OBSERVATION (the origin did not answer) without a claim about who runs it —
 * the identical fix labelAge got: drop the possessive, keep the fact.
 */
const INTERNAL_ORIGIN_MARKER = ' [origin did not respond — retry before concluding the named source is down]';

/**
 * Supabase's data plane for a project is `<ref>.supabase.co`, where the ref is
 * exactly twenty lowercase letters (ours is `pqauisounztsgdgfkhke`).
 *
 * Matching the shape rather than listing the ref keeps this correct when we add
 * a project — `supabaseEnv` on a pack entry already points some packs at a
 * second one — while still excluding `status.supabase.co`, which is Supabase's
 * own status page and emphatically not our database. Verified 2026-09-02 by
 * `grep -rhoE '[a-z0-9-]+\.supabase\.(co|in)' mcps shared workers scripts`: the
 * only real project ref anywhere in the tree is ours, the rest are doc
 * placeholders (`abc`, `xyz`, `example`) which this pattern also excludes. Same
 * finding internal-db-class.ts relies on for the PostgREST envelope being ours
 * by construction.
 */
const SUPABASE_PROJECT_HOST = /^[a-z]{20}\.supabase\.(co|in)$/;

/**
 * Is this a host WE run?
 *
 * Deliberately NOT including `*.workers.dev`: plenty of third-party APIs are
 * hosted on workers.dev, so the suffix says where something runs and not who
 * owns it. Every internal call we actually make goes to a `pipeworx.io`
 * hostname or to our Supabase project, both of which are ownership facts.
 *
 * `workers/gateway/src/provenance.ts`'s `OUR_HOSTS` answers the same
 * question and DOES include `workers.dev` — a documented divergence
 * (task #2051), not a bug to converge. That list decides what a response may
 * cite as a data SOURCE, where a false negative (citing our own worker as an
 * external source) is the hosting-disclosure leak this whole file exists to
 * prevent, so it errs broad. This one decides who gets BLAMED for a 5xx in
 * outage metrics read by on-call, where a false positive (crediting our own
 * infra with a third party's outage) hides the real failure, so it errs
 * narrow. Same suffix, opposite direction, because they are never called for
 * the same reason.
 *
 * Returns false on anything unparseable rather than throwing — this runs inside
 * an error path, and an error path that can itself throw turns a diagnosable
 * failure into a mystery.
 */
function isPipeworxOrigin(url: string | URL | undefined | null): boolean {
  if (!url) return false;
  let host: string;
  try {
    host = new URL(url instanceof URL ? url.href : url).hostname.toLowerCase();
  } catch {
    return false;
  }
  if (host === 'pipeworx.io' || host.endsWith('.pipeworx.io')) return true;
  return SUPABASE_PROJECT_HOST.test(host);
}

/**
 * Append the marker when this failure was OUR origin failing to answer.
 *
 * `status` is the HTTP status when there is one, and omitted for a timeout —
 * where there is no response at all, and "the origin did not answer" is the
 * whole observation. Statuses below 500 are left alone: a 404 from our own
 * registry for a slug that does not exist is the caller's argument, not our
 * outage, and marking it would put ordinary 404s on the incident dashboard.
 *
 * Idempotent, so a message that is wrapped and re-marked on the way up (the
 * fleet pack's retry loop re-throws through two layers) carries the marker once.
 */
function markInternalOrigin(
  message: string,
  url: string | URL | undefined | null,
  status?: number,
): string {
  if (status !== undefined && status < 500) return message;
  if (!isPipeworxOrigin(url)) return message;
  if (message.includes(INTERNAL_ORIGIN_MARKER)) return message;
  return message + INTERNAL_ORIGIN_MARKER;
}

/**
 * Which blob4 value a failure from our own web services books as, or undefined
 * if this is not one.
 *
 * Ordered AFTER `internalDbMetricsClass` at the call site: a PostgREST envelope
 * from our own Supabase is a strictly more specific statement about the same
 * row (which of our services, and why), and the two cannot disagree about
 * whether the failure is ours.
 */
function internalHostMetricsClass(error: string): string | undefined {
  return error.includes(INTERNAL_ORIGIN_MARKER) ? INTERNAL_SERVICE_UNREACHABLE_CLASS : undefined;
}


/**
 * One place to turn a failed `fetch` into an error a caller can act on.
 *
 * Nearly every pack was written the same way:
 *
 *     if (!res.ok) throw new Error(`Unsplash: ${res.status}`);
 *
 * which discards the response body — and the body is usually where the upstream
 * says what was actually wrong ("**symbol** not found: GBP", "parameter `year`
 * out of range", "unknown taxonomy id"). The caller gets a number, cannot
 * self-correct, and retries the same broken call. A 2026-07-31 sweep found this
 * shape in 481 of 1,400 packs, 47 of them PLATFORM-keyed.
 *
 * It also hides bugs one level down. Two of the first three packs audited had a
 * second defect that only existed because of this line: unsplash's rate-limit
 * branch sat BELOW a catch-all and was unreachable, and bea-gov parsed
 * `BEAAPI.Error.APIErrorDescription` below a `!res.ok` throw that made the
 * parsing dead code for every non-200.
 *
 * DELIBERATELY NOT A CLASSIFIER. It does not add `user_error:` /
 * `upstream_down:` prefixes. Those decide which tier a failure lands in, and the
 * `error` tier is what the daily problem-tools list is built from — it means
 * "Pipeworx has a defect". A 400 is genuinely ambiguous: often a caller's bad
 * argument, but sometimes a query WE built wrong (ted-eu comma-joined its CPV
 * values into something TED rejected, and that bug was found only because it sat
 * in `error`). Blanket-classifying 400s as caller mistakes would have hidden it.
 * A pack that KNOWS which it is should keep saying so explicitly; this helper is
 * for the 481 that say nothing at all.
 */

/** Longest upstream explanation we'll pass through. Enough for a real message,
 *  short enough that an HTML page or a stack trace can't swamp the error. */

const MAX_DETAIL = 300;

/**
 * Default bound for `fetchWithTimeout` when a pack doesn't state its own.
 *
 * 25s mirrors the number `epo-ops` landed on after measuring the real failure:
 * a degraded upstream that doesn't error, it just never answers, and a Worker
 * sits in `await fetch()` until ITS OWN execution budget kills the request —
 * which can take minutes, not seconds (epo_ops_search_patents measured 4-8
 * MINUTE hangs before this existed). 25s is short enough that a caller gets a
 * fast, actionable error instead of holding the connection, and long enough
 * that it doesn't false-trip on a merely-slow-but-alive upstream.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 25_000;

/**
 * Read the body of a failed response and fold it into a throwable Error.
 *
 * Usage — note the `await`, which is the one thing that makes this a mechanical
 * change rather than a drop-in:
 *
 *     if (!res.ok) throw await httpError(res, 'Unsplash');
 *
 * Safe to call on any non-ok response: a body that is missing, empty, unreadable
 * or HTML degrades to exactly the old `Name: 404` string rather than throwing
 * something new from inside the error path.
 */
async function httpError(res: Response, name: string): Promise<Error> {
  return new Error(await httpErrorMessage(res, name));
}

/** The message text without constructing an Error — for packs that need to wrap
 *  it in their own envelope or add an explicit classification prefix. */
async function httpErrorMessage(res: Response, name: string): Promise<string> {
  // The one place a 5xx from a host WE run gets stamped as ours. `res.url` is
  // the URL the fetch actually resolved to (after redirects), so this is a fact
  // about the call rather than a guess from the `name` the pack passed in —
  // reword that label freely, the class does not move. See
  // internal-host-class.ts; no-op for every third-party upstream, which is why
  // this touches 481 packs' error text and changes none of it.
  return markInternalOrigin(
    `${name}: ${res.status}${detailSuffix(await readDetail(res))}`,
    res.url,
    res.status,
  );
}

/**
 * Just the upstream's own explanation — no name, no status.
 *
 * For a pack that has already said both in its own sentence. epo-ops reads
 * `EPO rejected this search as too large (HTTP 413) — ${httpErrorMessage(…)}`,
 * which rendered as `… (HTTP 413) — EPO: 413.` once the XML detail was being
 * dropped: the upstream named twice, the status twice, and the one thing EPO
 * actually said ("Not enough characters before truncation character") nowhere
 * (fleet #712). Returns '' when the body carries nothing readable, so a caller
 * can fall back to its own wording.
 */
async function upstreamDetail(res: Response): Promise<string> {
  return readDetail(res);
}

/**
 * Read a SUCCESSFUL response as JSON, failing loudly when it isn't JSON.
 *
 * `httpError` above only ever runs on `!res.ok`, which leaves the nastier half
 * of the problem unhandled: an upstream that answers **HTTP 200 with an HTML
 * page**. A bot wall, a login redirect, a maintenance interstitial and a CDN
 * error page are all 200s, so `res.ok` is true, and `res.json()` then throws
 * `Unexpected token '<', "<!DOCTYPE "... is not valid JSON`.
 *
 * That string is the problem. It names no upstream, carries no status, and
 * reads like a parser bug in Pipeworx — so it lands in the `error` tier, which
 * means "we have a defect", and the caller is told nothing they can act on.
 * data.govt.nz sat dead behind an Imperva challenge this way and every
 * status-code health check we own reported it green (7889a845). A zero-length
 * body has the same shape: `Unexpected end of JSON input`, seen this week on
 * uk-gazette (83% of external calls) and census.
 *
 * UNLIKE `httpError`, this one DOES classify, and the asymmetry is deliberate.
 * A 400 is genuinely ambiguous — often the caller's bad argument, sometimes a
 * query we built wrong — so blanket-classifying it would hide our own bugs.
 * There is no such ambiguity here: **no argument a caller can pass makes a JSON
 * API return an HTML page.** It is always the upstream, so `upstream_down:` is
 * a statement of fact rather than a guess, and it keeps these out of the
 * problem-tools list where they crowd out real defects.
 *
 *     const data = await parseJson<Feed>(res, 'UK Gazette');
 *
 * Call it only after the `!res.ok` check — on a failed response you want
 * `httpError`, which mines the body for the upstream's own explanation.
 */
async function parseJson<T>(res: Response, name: string): Promise<T> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    throw new Error(
      `upstream_down: ${name} returned a body that could not be read (HTTP ${res.status}). ` +
        'The connection most likely dropped mid-response; retrying is reasonable.',
    );
  }

  const type = res.headers.get('content-type') ?? 'no content-type';

  if (!raw.trim()) {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with an EMPTY body where JSON was expected (${type}). ` +
        'Nothing about the request can cause this — it is an upstream fault, and the same call may well work on retry.',
    );
  }

  // Checked before parsing rather than in the catch, because knowing it is
  // markup is what turns "we failed to parse something" into "they served a
  // web page" — the second is diagnosable, the first is not.
  const head = raw.slice(0, 200).trimStart().toLowerCase();
  if (head.startsWith('<!doctype') || head.startsWith('<html') || head.startsWith('<?xml')) {
    const kind = head.startsWith('<?xml') ? 'an XML document' : 'an HTML page';
    // The summary, not the source. Pasting the first 120 characters of a web
    // page handed the agent `<!DOCTYPE html><html lang="en"…` — the same leak
    // this branch exists to describe (fleet #712).
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with ${kind} instead of JSON (${type}). ` +
        'That is typically a bot wall, a login redirect or a maintenance page — it is returned as a SUCCESS, ' +
        `so status-code health checks read it as fine. No argument change will get past it. ` +
        `The page says: ${summarizeErrorBody(raw) || 'nothing readable'}`,
    );
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(
      `upstream_down: ${name} answered HTTP ${res.status} with a body that is not valid JSON (${type}). ` +
        `It begins: ${stripMarkup(raw).slice(0, 120) || '(unreadable)'}`,
    );
  }
}

/**
 * `fetch`, but bounded — the fix for a systemic gap found 2026-08-30: a grep
 * audit of every pack's `mcps/*\/src/index.ts` found 1,339 of ~1,500 call
 * `fetch()` with NO timeout guard anywhere in the file. Two of those
 * (epo-ops, statcan) were confirmed live-hanging for 4-8 minutes before this
 * existed — every unguarded call carries the same risk, just unconfirmed.
 *
 * Mirrors the `epoFetch` wrapper `mcps/epo-ops/src/index.ts` shipped first:
 * bound the request with `AbortSignal.timeout`, and on a timeout/abort throw
 * an `upstream_down:` error that names the upstream and the bound rather than
 * letting the raw `TimeoutError`/`AbortError` (which names neither) propagate.
 * `upstream_down:` is deliberate, same reasoning as `parseJson` above — no
 * argument a caller passes can make an upstream hang, so it is always the
 * upstream's fault, and marking it that way keeps a slow API off the
 * problem-tools list where it would crowd out our own defects.
 *
 * Usage — a mechanical swap for a bare `fetch(url, init)`:
 *
 *     const res = await fetchWithTimeout(url, init, 'Some API');
 *
 * Pass `timeoutMs` as a fourth argument to override the default for a pack
 * with a known-slower upstream; the label should be the same short name you'd
 * pass to `httpError`/`httpErrorMessage` for that call.
 */
async function fetchWithTimeout(
  url: string | URL,
  init: RequestInit = {},
  name: string,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      // States the OBSERVATION (no response in N seconds), not a diagnosis.
      // "appears to be degraded" is an inference about the vendor that we have
      // not checked, and it is wrong in a way that misdirects whoever reads it:
      // a timeout from a Worker can equally mean OUR egress is blocked.
      //
      // Measured today (2026-09-01, fleet #1047): every call to
      // mainnet.base.org failed from the x402 facilitator while the identical
      // request from a laptop returned 200. Base was entirely healthy; the
      // public RPC refuses Cloudflare Worker egress. Had this message fired
      // there it would have blamed Base by name, and the next person would have
      // waited for a vendor outage to clear that did not exist.
      // A timeout has no status to test — there is no response at all — so
      // `markInternalOrigin` is called without one: an origin we run that never
      // answered is an availability failure by definition. This is the half of
      // fleet #1096 with neither a SQLSTATE nor a status code to key on.
      throw new Error(
        markInternalOrigin(
          `upstream_down: ${name} did not respond within ${timeoutMs / 1000}s. ` +
            `That can be ${name} being slow or down, or this environment being unable to reach it ` +
            `(some hosts refuse datacenter/Worker egress) — retry shortly, and check reachability ` +
            `from elsewhere before concluding ${name} is down.`,
          url,
        ),
      );
    }
    throw err;
  }
}

function detailSuffix(detail: string): string {
  return detail ? ` — ${detail}` : '';
}

async function readDetail(res: Response): Promise<string> {
  let raw: string;
  try {
    raw = await res.text();
  } catch {
    // Body already consumed, or the connection died mid-read. The status alone
    // is still worth throwing — never let the error path throw its own error.
    return '';
  }
  return summarizeErrorBody(raw);
}

/**
 * Turn ANY error body — JSON, HTML, XML or plain text — into one short phrase
 * that never contains markup.
 *
 * This used to just drop an HTML or XML body on the floor, on the reasoning
 * that markup crowds out the status. That was half right. Dropping it loses the
 * one sentence a caller could have acted on: an `Access Denied` title, an SDMX
 * `<message:Error>` text, an OPS fault string. A 2026-08-30 support sweep
 * measured 13 of 291 caller-facing error rows carrying a raw page or document
 * verbatim, across 11 packs, and in every one of them the useful content —
 * "Access Denied", "Invalid country code", "SCRAPE_TIMEOUT" — was in there,
 * buried in markup the agent had to parse out of a string (fleet #712).
 *
 * So: extract the meaning, discard the markup. The output is passed through
 * `stripMarkup` unconditionally, which is what lets `check:error-body-leak`
 * assert mechanically that no caller-facing message can contain `<?xml`,
 * `<!DOCTYPE` or `<html`.
 */
function summarizeErrorBody(raw: string): string {
  if (!raw || !raw.trim()) return '';

  const head = raw.slice(0, 400).trimStart().toLowerCase();

  // An HTML error page (Cloudflare interstitial, nginx default, a login
  // redirect) says what it is in its <title>, and almost nowhere else.
  if (head.startsWith('<!doctype') || head.startsWith('<html')) {
    const title = htmlTitle(raw);
    return title
      ? `${title} (upstream returned an HTML error page, not an API response)`
      : 'upstream returned an HTML error page, not an API response';
  }

  // XML fault documents — EPO OPS, SDMX (`<message:Error>`), SOAP faults. The
  // human sentence sits in a child element whose tag name says what it is.
  if (head.startsWith('<?xml') || head.startsWith('<')) {
    const fault = xmlFaultText(raw);
    return fault
      ? `${stripMarkup(fault).slice(0, MAX_DETAIL)} (from the upstream's XML error document)`
      : 'upstream returned an XML error document with no readable message';
  }

  // Most JSON error bodies bury one human sentence among ids and echoed request
  // params. Prefer that sentence; fall back to the whole body when the shape is
  // unfamiliar, since an unfamiliar shape is exactly when we can least afford to
  // guess wrong and show nothing.
  const fromJson = messageFromJson(raw);
  return stripMarkup(fromJson ?? raw).slice(0, MAX_DETAIL);
}

/** The `<title>` of an HTML error page, or its first `<h1>` — the two places a
 *  bot wall, a 502 and an "Access Denied" all state what happened. */
function htmlTitle(raw: string): string | null {
  const head = raw.slice(0, 4000);
  for (const re of [/<title[^>]*>([\s\S]*?)<\/title>/i, /<h1[^>]*>([\s\S]*?)<\/h1>/i]) {
    const m = re.exec(head);
    const text = m ? stripMarkup(m[1]) : '';
    if (text) return text.slice(0, 160);
  }
  return null;
}

/** Tag names that carry the explanation in an XML fault document, namespace
 *  prefix optional (`<message:Error>`, `<com:Text>`, `<faultstring>`). */
const XML_FAULT_TAG_RE =
  /<(?:[A-Za-z0-9_.-]+:)?(?:text|message|description|faultstring|reason|detail|title|errormessage|error)\b[^>]*>([^<]{2,400})</i;

function xmlFaultText(raw: string): string | null {
  const head = raw.slice(0, 8000);
  const tagged = XML_FAULT_TAG_RE.exec(head);
  if (tagged && tagged[1].trim()) return tagged[1];

  // Nothing conventionally named — take the longest text node instead. A fault
  // document with one sentence in an oddly named element is still readable;
  // returning nothing at all is not.
  let best = '';
  for (const m of head.matchAll(/>([^<>]{8,400})</g)) {
    const text = m[1].trim();
    if (text.length > best.length) best = text;
  }
  return best || null;
}

/**
 * Remove every tag and stray angle bracket, then collapse whitespace.
 *
 * Applied to everything on the way out, including the JSON and plain-text
 * paths, because an upstream is free to embed markup in a JSON string field —
 * and a leak is a leak regardless of which branch produced it.
 */
function stripMarkup(s: string): string {
  return collapse(decodeEntities(s.replace(/<[^>]*>/g, ' ')).replace(/[<>]/g, ' '));
}

/** The handful of entities that show up in error-page titles. Decoded AFTER
 *  tags are stripped and BEFORE the angle-bracket sweep, so `&lt;script&gt;`
 *  in a title cannot decode into markup that survives — EMBL-EBI's ChEMBL 500
 *  page renders as `500 Internal Server Error &lt; EMBL-EBI` otherwise. */
function decodeEntities(s: string): string {
  return s
    .replace(/&(?:amp|#0*38);/gi, '&')
    .replace(/&(?:lt|#0*60);/gi, '<')
    .replace(/&(?:gt|#0*62);/gi, '>')
    .replace(/&(?:quot|#0*34);/gi, '"')
    .replace(/&(?:#0*39|apos|#x0*27);/gi, "'")
    .replace(/&nbsp;/gi, ' ');
}

/** The conventional "what went wrong" field, under any of the names upstreams
 *  actually use. Checked in order; first non-empty string wins. */
const MESSAGE_KEYS = [
  'message', 'error_message', 'errorMessage', 'detail', 'details',
  'description', 'error_description', 'reason', 'title', 'fault',
];

function messageFromJson(raw: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  return pickMessage(parsed, 0);
}

function pickMessage(node: unknown, depth: number): string | null {
  // Two levels covers `{error: {message}}` and `{errors: [{detail}]}`, the two
  // shapes that account for nearly all of them, without walking a large payload.
  if (depth > 2 || node == null) return null;

  if (typeof node === 'string') return node.trim() || null;

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = pickMessage(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  if (typeof node !== 'object') return null;
  const obj = node as Record<string, unknown>;

  for (const key of MESSAGE_KEYS) {
    const v = obj[key];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  // `{error: …}` where error is itself an object or a string — the single most
  // common wrapper, so it is worth descending into by name rather than scanning
  // every key and risking picking up an echoed request parameter.
  for (const key of ['error', 'errors', 'fault', 'Error', 'data']) {
    if (key in obj) {
      const found = pickMessage(obj[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/** Errors are read in a single line of log output; newlines and runs of
 *  whitespace make a multi-line body unreadable there. */
function collapse(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}
/**
 * Taiwan's statutory company register: every incorporated company, its 統一編號, capital, registered address and current legal standing, from the Ministry of Economic Affairs.
 *
 * Served by the Department of Commerce (商業司) open-data OData service at
 * data.gcis.nat.gov.tw.
 *
 * This is the statutory register: every company incorporated in Taiwan, its
 * 統一編號 (Business Administration Number / BAN, the 8-digit tax and company
 * id), registered name, responsible person, capital, registered address,
 * registering authority and current registration standing.
 *
 * NOT a duplicate of the existing Taiwan packs. `taiwan-procurement` reads the
 * public-tender bulletin (who won which government contract) and
 * `taiwan-stocks` reads TWSE/TPEx market data (prices for the ~1,800 listed
 * issuers). This pack is the ~800,000-entity corporate REGISTER underneath
 * both: it resolves a 統一編號 that appears in a tender award, and it covers
 * the overwhelming majority of Taiwanese companies, which are not listed.
 *
 * TRAPS, ALL VERIFIED LIVE 2026-09-17. Every one of them is a silent zero —
 * HTTP 200 with an empty body — which is the failure class that does not page
 * anyone (docs/silent-zero-policy.md).
 *
 * 1. THE NAME SEARCH REQUIRES A STATUS FILTER. Dataset
 *    6BBA2268-1367-4B42-9CCA-BC17499EBE8C answers
 *    `$filter=Company_Name like 台積電` with HTTP 200 and ZERO BYTES. It only
 *    returns rows for `Company_Name like X and Company_Status eq NN`. There is
 *    no error and no hint. `twcompany_search_name` always sends a status.
 * 2. ONLY THREE STATUS CODES EXIST. 01 核准設立 (registered/active),
 *    04 解散 (dissolved), 05 撤銷 (revoked). 02, 03, 06-09 all answer with an
 *    empty body, which reads identically to "no such company".
 * 3. THE TWO DATASETS ARE NOT INTERCHANGEABLE. 6BBA2268 does name search and
 *    ignores `Business_Accounting_NO`; 5F64D864 does BAN lookup and returns
 *    nothing for a `Company_Name like` filter. Each answers the other's query
 *    with an empty 200.
 * 4. AN UNKNOWN DATASET ID ANSWERS HTTP 200 WITH CHINESE PROSE —
 *    「此API不存在，請查明後繼續。」 — not JSON and not a 404. JSON.parse then
 *    throws something that reads like our bug.
 * 5. DATES ARE MINGUO (ROC) ERA, ZERO-PADDED YYYMMDD with no separators.
 *    "0760221" is 1987-02-21 (076 + 1911), "1150821" is 2026-08-21. Read as a
 *    Gregorian number it is off by 1,911 years, and 0760221 looks like a
 *    plausible integer. Every date field is converted here and BOTH forms are
 *    returned.
 * 6. Amounts are in New Taiwan dollars and come back as bare numbers.
 *    Capital_Stock_Amount is AUTHORISED capital; Paid_In_Capital_Amount is
 *    what was actually paid in. They differ by billions for large issuers.
 *
 * Keyless. No registration, no key, no published quota.
 */


const OD = 'https://data.gcis.nat.gov.tw/od/data/api';
/** 公司登記基本資料 by 統一編號 — the full record. See trap 3. */
const DS_BY_BAN = '5F64D864-61CB-4D0D-8AD9-492047CC1EA6';
/** 公司登記基本資料 by 公司名稱 — name search only, status filter mandatory. */
const DS_BY_NAME = '6BBA2268-1367-4B42-9CCA-BC17499EBE8C';

const UA = 'pipeworx-mcp-taiwan-companies/1.0 (+https://pipeworx.io)';

/** Trap 2. These three are the whole set; anything else returns an empty 200. */
const STATUS_CODES: Record<string, { zh: string; en: string }> = {
  '01': { zh: '核准設立', en: 'registered / active' },
  '04': { zh: '解散', en: 'dissolved' },
  '05': { zh: '撤銷', en: 'registration revoked' },
};

async function pwFetch(url: string): Promise<Response> {
  return fetchWithTimeout(
    url,
    { headers: { 'User-Agent': UA, Accept: 'application/json' } },
    'Taiwan MOEA Department of Commerce (GCIS open data)',
  );
}

/**
 * One OData GET. Handles both silent-zero shapes: an empty body (trap 1/3) and
 * the Chinese "this API does not exist" prose (trap 4).
 */
async function odata(dataset: string, filter: string, skip?: number, top?: number): Promise<Record<string, unknown>[]> {
  // The GCIS service wants literal `$` in the query string and rejects a fully
  // percent-encoded `%24format`, so the parameter names are assembled here
  // rather than through URLSearchParams.
  const parts = [`$format=json`, `$filter=${encodeURIComponent(filter)}`];
  if (typeof skip === 'number') parts.push(`$skip=${skip}`);
  if (typeof top === 'number') parts.push(`$top=${top}`);
  const url = `${OD}/${dataset}?${parts.join('&')}`;

  const res = await pwFetch(url);
  const body = (await res.text()).trim();
  if (!res.ok) {
    throw new Error(`GCIS open data returned HTTP ${res.status} for dataset ${dataset}. ${summarizeErrorBody(body)}`);
  }
  if (!body) return []; // Trap 1/3: a legitimate empty result looks exactly like this.
  if (!body.startsWith('[') && !body.startsWith('{')) {
    // Trap 4.
    throw new Error(
      `GCIS open data answered HTTP 200 with a non-JSON body for dataset ${dataset}, which is how it reports an unknown dataset id: ${summarizeErrorBody(body)}`,
    );
  }
  const parsed = JSON.parse(body);
  return Array.isArray(parsed) ? parsed : [parsed];
}

/** Trap 5: Minguo YYYMMDD -> ISO YYYY-MM-DD. Returns null for blank/garbage. */
function rocToIso(raw: unknown): string | null {
  const s = String(raw ?? '').trim();
  if (!/^\d{6,7}$/.test(s)) return null;
  const day = s.slice(-2);
  const month = s.slice(-4, -2);
  const year = Number(s.slice(0, s.length - 4)) + 1911;
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > 31) return null;
  return `${year}-${month}-${day}`;
}

function str(row: Record<string, unknown>, key: string): string | null {
  const v = row[key];
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

function num(row: Record<string, unknown>, key: string): number | null {
  const v = row[key];
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeBan(raw: unknown): string {
  const ban = String(raw ?? '').replace(/\D/g, '');
  if (!/^\d{8}$/.test(ban)) {
    throw new Error(
      `\`ban\` must be an 8-digit Taiwan 統一編號 (Business Administration Number), e.g. 22099131 — got "${String(raw ?? '')}".`,
    );
  }
  return ban;
}

/**
 * OData string literals here are unquoted after `like` / `eq` for text (the
 * service's own documented examples do this), so the one thing that must not
 * reach it is a filter separator. Rejecting rather than silently stripping,
 * because a stripped query returns a confidently wrong answer.
 */
function assertSafeTerm(term: string): void {
  if (/[&?#'"]/.test(term) || /\b(and|or)\b/i.test(term)) {
    throw new Error(
      `\`name\` may not contain & ? # quotes or the words "and"/"or" — the GCIS OData filter would parse them as query syntax. Got "${term}".`,
    );
  }
}

function clamp(raw: unknown, fallback: number, max: number): number {
  const n = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), max);
}

/**
 * The BAN dataset returns only `Company_Status_Desc` and omits the numeric
 * `Company_Status` the name dataset carries (trap 3, again). Without this the
 * English standing silently disappears on exactly the lookup most callers use.
 */
function statusEnFromDesc(desc: string | null): string | null {
  if (!desc) return null;
  for (const v of Object.values(STATUS_CODES)) if (desc.includes(v.zh)) return v.en;
  if (/廢止/.test(desc)) return 'registration abolished';
  if (/停業/.test(desc)) return 'business suspended';
  return null;
}

function shapeRecord(row: Record<string, unknown>) {
  const statusCode = str(row, 'Company_Status');
  const statusZh = str(row, 'Company_Status_Desc');
  const known = statusCode ? STATUS_CODES[statusCode] : undefined;
  return {
    ban: str(row, 'Business_Accounting_NO'),
    name: str(row, 'Company_Name'),
    status_code: statusCode,
    status_zh: statusZh ?? known?.zh ?? null,
    status_en: known?.en ?? statusEnFromDesc(statusZh),
    responsible_person: str(row, 'Responsible_Name'),
    authorised_capital_twd: num(row, 'Capital_Stock_Amount'),
    paid_in_capital_twd: num(row, 'Paid_In_Capital_Amount'),
    share_par_value_twd: num(row, 'Share_Val'),
    registered_address: str(row, 'Company_Location'),
    registering_authority: str(row, 'Register_Organization_Desc'),
    registering_authority_code: str(row, 'Register_Organization'),
    incorporated_on: rocToIso(row.Company_Setup_Date),
    incorporated_on_roc: str(row, 'Company_Setup_Date'),
    last_amended_on: rocToIso(row.Change_Of_Approval_Data),
    last_amended_on_roc: str(row, 'Change_Of_Approval_Data'),
  };
}

const tools: McpToolExport['tools'] = [
  {
    name: 'twcompany_search_name',
    description:
      "Search Taiwan's statutory company register by company name (Chinese or partial), from the Ministry of Economic Affairs Department of Commerce open data. Returns each match's 統一編號 (8-digit Business Administration Number), registered name, responsible person, authorised and paid-in capital in TWD, registered address and registering authority. AUTHORITATIVE for whether a Taiwanese company legally exists and under what number — this is the register of record, covering every incorporated company, not only the ~1,800 listed on TWSE/TPEx. PREFER OVER WEB SEARCH for Taiwanese corporate identity, ownership-chain and counterparty-verification questions.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description:
            'Company name or a fragment of it, normally in Traditional Chinese, e.g. 台積電 or 銀行. Matched as a substring by the register.',
        },
        status: {
          type: 'string',
          description:
            "Registration status to search within. 01 = 核准設立 (registered/active, the default), 04 = 解散 (dissolved), 05 = 撤銷 (revoked). Only these three exist; the register returns an empty result for any other code.",
          enum: ['01', '04', '05'],
        },
        limit: { type: 'number', description: 'Maximum companies to return (default 20, max 100).' },
        offset: { type: 'number', description: 'Rows to skip, for paging through a common name (default 0).' },
      },
      required: ['name'],
    },
  },
  {
    name: 'twcompany_by_ban',
    description:
      "Full registration record for one Taiwanese company by its 統一編號 (8-digit Business Administration Number, the id printed on every Taiwanese invoice and used in government tender awards). Returns registered name, responsible person, authorised and paid-in capital, par value, registered address, registering authority, incorporation date and the date of the most recent registered amendment — sourced from Taiwan's Ministry of Economic Affairs company register. AUTHORITATIVE for resolving a Taiwanese tax/company number to the entity behind it.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        ban: {
          type: 'string',
          description: 'The 8-digit 統一編號 / Business Administration Number, e.g. 22099131 (TSMC).',
        },
      },
      required: ['ban'],
    },
  },
  {
    name: 'twcompany_status',
    description:
      'Current legal standing of a Taiwanese company by 統一編號 — whether it is still registered, dissolved, revoked, or in a declared suspension of business — with every register date converted from Minguo (ROC) era to ISO. Answers "is this Taiwanese counterparty still a going concern on the register", which the raw record leaves in six separate era-coded fields. Sourced from the Ministry of Economic Affairs company register.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ban: {
          type: 'string',
          description: 'The 8-digit 統一編號 / Business Administration Number, e.g. 22099131.',
        },
      },
      required: ['ban'],
    },
  },
];

async function searchName(args: Record<string, unknown>) {
  const name = String(args.name ?? '').trim();
  if (!name) throw new Error('`name` is required — give a company name or a fragment of one, e.g. 台積電.');
  assertSafeTerm(name);
  const status = args.status ? String(args.status).trim() : '01';
  if (!STATUS_CODES[status]) {
    throw new Error(
      `\`status\` must be one of 01 (核准設立, active), 04 (解散, dissolved) or 05 (撤銷, revoked) — got "${status}". The register answers every other code with an empty result rather than an error.`,
    );
  }
  const limit = clamp(args.limit, 20, 100);
  const offset = Number.isFinite(Number(args.offset)) && Number(args.offset) > 0 ? Math.floor(Number(args.offset)) : 0;

  // Trap 1: the status term is not optional.
  const rows = await odata(DS_BY_NAME, `Company_Name like ${name} and Company_Status eq ${status}`, offset, limit);
  const companies = rows.map(shapeRecord);

  return {
    name,
    status,
    status_zh: STATUS_CODES[status].zh,
    status_en: STATUS_CODES[status].en,
    offset,
    count: companies.length,
    companies,
    source: 'Company registration basic data, Department of Commerce, Ministry of Economic Affairs (Taiwan)',
    source_url: `${OD}/${DS_BY_NAME}`,
    note: companies.length
      ? undefined
      : `No company whose registered name contains "${name}" has status ${status} (${STATUS_CODES[status].zh}). Registered names are the full legal form — 台灣積體電路製造股份有限公司, not TSMC — so try a shorter Chinese fragment, or search status 04/05 for a dissolved or revoked entity.`,
  };
}

async function byBan(args: Record<string, unknown>) {
  const ban = normalizeBan(args.ban);
  const rows = await odata(DS_BY_BAN, `Business_Accounting_NO eq ${ban}`);
  if (!rows.length) {
    return {
      found: false,
      ban,
      note: `No company is registered under 統一編號 ${ban}. The number may belong to a sole proprietorship or partnership (商業登記), which is a separate register, or it may simply not exist — the check digit is not validated here.`,
      source: 'Company registration basic data, Department of Commerce, Ministry of Economic Affairs (Taiwan)',
      source_url: `${OD}/${DS_BY_BAN}`,
    };
  }
  const row = rows[0];
  return {
    found: true,
    ...shapeRecord(row),
    equity_amount_twd: num(row, 'Equity_Amt'),
    revoked_on: rocToIso(row.Revoke_App_Date),
    case_status: str(row, 'Case_Status_Desc') ?? str(row, 'Case_Status'),
    suspension_applied_on: rocToIso(row.Sus_App_Date),
    suspension_begins_on: rocToIso(row.Sus_Beg_Date),
    suspension_ends_on: rocToIso(row.Sus_End_Date),
    source: 'Company registration basic data, Department of Commerce, Ministry of Economic Affairs (Taiwan)',
    source_url: `${OD}/${DS_BY_BAN}`,
  };
}

async function status(args: Record<string, unknown>) {
  const ban = normalizeBan(args.ban);
  const rows = await odata(DS_BY_BAN, `Business_Accounting_NO eq ${ban}`);
  if (!rows.length) {
    return {
      found: false,
      ban,
      note: `No company is registered under 統一編號 ${ban}.`,
      source: 'Company registration basic data, Department of Commerce, Ministry of Economic Affairs (Taiwan)',
      source_url: `${OD}/${DS_BY_BAN}`,
    };
  }
  const row = rows[0];
  const statusZh = str(row, 'Company_Status_Desc');
  const revokedOn = rocToIso(row.Revoke_App_Date);
  const susBegin = rocToIso(row.Sus_Beg_Date);
  const susEnd = rocToIso(row.Sus_End_Date);

  // Derived from the register's own fields, in the order the register itself
  // treats as final: a revocation or dissolution ends the company; a declared
  // suspension is a temporary state on a company that still exists.
  const dissolved = !!statusZh && /解散|撤銷|廢止|命令解散/.test(statusZh);
  const today = new Date().toISOString().slice(0, 10);
  const suspended = !!susBegin && (!susEnd || susEnd >= today) && susBegin <= today;

  let standing: 'dissolved_or_revoked' | 'suspended' | 'registered';
  if (dissolved || revokedOn) standing = 'dissolved_or_revoked';
  else if (suspended) standing = 'suspended';
  else standing = 'registered';

  return {
    found: true,
    ban,
    name: str(row, 'Company_Name'),
    standing,
    standing_explained:
      standing === 'dissolved_or_revoked'
        ? 'The register records this company as dissolved or its registration revoked. It is not a going concern on the register.'
        : standing === 'suspended'
          ? 'The register records a declared suspension of business that covers today. The company still exists but has told the authority it is not trading.'
          : 'The register records this company as validly registered, with no revocation and no suspension covering today.',
    status_code: str(row, 'Company_Status'),
    status_zh: statusZh,
    incorporated_on: rocToIso(row.Company_Setup_Date),
    last_amended_on: rocToIso(row.Change_Of_Approval_Data),
    revoked_on: revokedOn,
    suspension_applied_on: rocToIso(row.Sus_App_Date),
    suspension_begins_on: susBegin,
    suspension_ends_on: susEnd,
    case_status: str(row, 'Case_Status_Desc') ?? str(row, 'Case_Status'),
    registering_authority: str(row, 'Register_Organization_Desc'),
    as_of: today,
    source: 'Company registration basic data, Department of Commerce, Ministry of Economic Affairs (Taiwan)',
    source_url: `${OD}/${DS_BY_BAN}`,
  };
}

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'twcompany_search_name':
      return searchName(args);
    case 'twcompany_by_ban':
      return byBan(args);
    case 'twcompany_status':
      return status(args);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
