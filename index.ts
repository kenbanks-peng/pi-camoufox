/**
 * Browser extension — Playwright-driven Browser pi can drive.
 *
 * Exposes a small set of tools the LLM can call to debug a live web app:
 *   - browser_goto         navigate
 *   - browser_eval         run JS in the page (read localStorage, decode JWTs,
 *                          inspect the DOM, etc.)
 *   - browser_console      drain buffered console + pageerror entries
 *   - browser_network      drain buffered network requests (status, headers)
 *   - browser_fill         fill an input
 *   - browser_click        click an element
 *   - browser_screenshot   write a PNG to /tmp and return the path
 *   - browser_close        close the persistent browser
 *
 * Plus /browser on, off and status controls from the TUI.
 *
 * Browser state is a singleton kept alive across tool calls so login
 * sessions, cookies, and localStorage survive between turns. It's torn
 * down on `session_shutdown`.
 *
 * Driver types only come from npm; runtime uses Python-bundled Playwright.
 * Setup: see runtime/README.md. Explicit installed Python and binary required.
 * PI_BROWSER_HEADED enables a visible window; PI_BROWSER_PROFILE overrides
 * the Browser-only persistent profile. Never point it at a Chromium profile.
 */

import { runWorkflow, bounded } from "./runtime/workflow-run.mjs";
import { validateWorkflow, LIMITS } from "./runtime/workflow.mjs";
import { loadWorkflow } from "./runtime/workflow-load.mjs";
import { prepareBrowser } from "./runtime/browser.mjs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type {
  BrowserContext,
  Page,
  ConsoleMessage,
  Request,
} from "playwright-core";

type ConsoleEntry = {
  ts: number;
  type: string;
  text: string;
  location?: string;
};

type NetEntry = {
  ts: number;
  method: string;
  url: string;
  status?: number;
  statusText?: string;
  resourceType: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  failure?: string;
};

const MAX_BUF = 1000;
const BROWSER_TOOL_NAMES = [
  "browser_run",
  "browser_goto",
  "browser_eval",
  "browser_console",
  "browser_network",
  "browser_fill",
  "browser_click",
  "browser_screenshot",
  "browser_close",
];
const ENABLED_ENTRY_TYPE = "browser-enabled";
const MODE_ENTRY_TYPE = "browser-mode";
const KEEP_HEADERS = new Set([
  "authorization",
  "apikey",
  "content-type",
  "x-client-info",
  "accept-profile",
  "content-profile",
  "prefer",
  "location",
  "www-authenticate",
  "retry-after",
]);

function pushBounded<T>(buf: T[], entry: T): void {
  buf.push(entry);
  if (buf.length > MAX_BUF) buf.splice(0, buf.length - MAX_BUF);
}

function filterHeaders(
  h: Record<string, string>,
  allow: Set<string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    if (allow.has(k.toLowerCase())) out[k] = v;
  }
  return out;
}

/**
 * Serialize all tool executions against the single shared Page.
 *
 * Playwright's Page is not concurrent-safe: if pi fires multiple browser_*
 * tools in one block (which it does by default for independent calls), two
 * `fill`s will race into the same field, and a `goto` followed by an `eval`
 * in the same batch will hit "Execution context was destroyed" because the
 * eval lands during the navigation teardown.
 *
 * Wrapping every execute body in this queue costs the latency we should be
 * paying anyway and removes the entire class of race from the LLM's mental
 * model.
 */
export default function browserExtension(pi: ExtensionAPI) {
  let opQueue: Promise<unknown> = Promise.resolve();
  let stopped = false;
  let poisoned = false;
  let gateReady = false;
  function serialize<T>(fn: () => Promise<T>, control = false): Promise<T> {
    const next = opQueue.then(async () => {
      if (poisoned) throw Error("Browser termination unconfirmed; fresh extension instance required. Do not reuse retained profiles without confirming termination.");
      if (!control && (stopped || (gateReady && !enabled))) {
        throw Error(stopped ? "Browser session shut down" : "Browser tools disabled; run /browser on");
      }
      return fn();
    });
    opQueue = next.catch(() => {});
    return next;
  }
  let context: BrowserContext | null = null;
  let page: Page | null = null;
  let crashed = false;
  const consoleBuf: ConsoleEntry[] = [];
  const netBuf: NetEntry[] = [];

  // XDG base directories must be absolute; empty/relative values use the default.
  const dataHome = process.env.XDG_DATA_HOME;
  const profileDir =
    process.env.PI_BROWSER_PROFILE ??
    join(dataHome && isAbsolute(dataHome) ? dataHome : join(homedir(), ".local", "share"), "pi-camoufox", "profile");
  let modeOverride: boolean | undefined;
  const isHeadless = () => modeOverride ?? !process.env.PI_BROWSER_HEADED;

  const observedPages = new WeakSet<Page>();

  async function ensurePage(): Promise<Page> {
    try {
      if (crashed) await teardown();
      return await acquirePage();
    } catch (error) {
      await teardown();
      throw error;
    }
  }

  async function acquirePage(): Promise<Page> {
    if (page && !page.isClosed()) return page;

    if (!context) {
      const { firefox, options, warnings } = await prepareBrowser({ headless: isHeadless() });
      if (warnings) console.warn(warnings);
      context = await firefox.launchPersistentContext(profileDir, {
        ...options,
        // Native Playwright timeout owns and reaps partially launched processes.
        // Do not Promise.race launch: a late result would escape ownership.
        timeout: 30_000,
        viewport: { width: 1280, height: 800 },
      });
      const owned = context!;
      const disconnected = () => {
        if (context === owned) {
          context = null;
          page = null;
        }
      };
      owned.on("close", disconnected);
      owned.browser()?.on("disconnected", disconnected);
    }

    page = context!.pages().find((candidate) => !candidate.isClosed()) ?? (await context!.newPage());
    if (observedPages.has(page)) return page;
    observedPages.add(page);

    page.on("crash", () => { if (page === observed) crashed = true; });
    const observed = page;
    page.on("console", (msg: ConsoleMessage) => {
      if (page !== observed) return;
      const loc = msg.location();
      pushBounded(consoleBuf, {
        ts: Date.now(),
        type: msg.type(),
        text: msg.text(),
        location: loc?.url ? `${loc.url}:${loc.lineNumber}` : undefined,
      });
    });
    page.on("pageerror", (err) => {
      if (page !== observed) return;
      pushBounded(consoleBuf, {
        ts: Date.now(),
        type: "pageerror",
        text: `${err.name}: ${err.message}`,
      });
    });
    page.on("requestfinished", async (req: Request) => {
      try {
        const res = await req.response();
        if (page !== observed) return;
        const entry: NetEntry = {
          ts: Date.now(),
          method: req.method(),
          url: req.url(),
          status: res?.status(),
          statusText: res?.statusText(),
          resourceType: req.resourceType(),
          // Capture all headers; the renderer decides what to surface based
          // on the caller's `verbose` / `includeHeaders` opt-in.
          requestHeaders: await req.allHeaders(),
          responseHeaders: res ? await res.allHeaders() : undefined,
        };
        if (page !== observed) return;
        pushBounded(netBuf, entry);
      } catch {
        // request may have been aborted; ignore
      }
    });
    page.on("requestfailed", (req: Request) => {
      if (page !== observed) return;
      pushBounded(netBuf, {
        ts: Date.now(),
        method: req.method(),
        url: req.url(),
        resourceType: req.resourceType(),
        failure: req.failure()?.errorText,
      });
    });

    return page;
  }

  async function teardown(): Promise<void> {
    const owned = context;
    crashed = false;
    // Detach before awaiting close; old events cannot clear a newer owner.
    context = null;
    page = null;
    consoleBuf.length = 0;
    netBuf.length = 0;
    if (owned) {
      const browser = owned.browser();
      try { await owned.close(); }
      finally {
        // Persistent context owns this browser; never enumerate/kill processes.
        if (browser?.isConnected()) await browser.close();
      }
    }
  }

  // Default-off gate. The browser tools collectively cost ~800 system-prompt
  // tokens (snippets + guidelines), but are needed in a small minority of
  // sessions. We keep all 8 tools registered so they appear in
  // pi.getAllTools() and command discovery stays normal, but we strip them
  // from the active set so their promptSnippet / promptGuidelines drop out
  // of the system prompt. They become callable again when /browser on flips
  // them back into the active set.
  let enabled = false;

  function setEnabled(on: boolean): void {
    const active = new Set(pi.getActiveTools());
    if (on) {
      for (const name of BROWSER_TOOL_NAMES) active.add(name);
    } else {
      for (const name of BROWSER_TOOL_NAMES) active.delete(name);
    }
    pi.setActiveTools(Array.from(active));
    enabled = on;
  }

  async function enable(): Promise<void> {
    if (stopped) throw Error("Browser session shut down");
    setEnabled(true);
    pi.appendEntry(ENABLED_ENTRY_TYPE, { on: true });
  }

  async function disable(): Promise<void> {
    setEnabled(false);
    pi.appendEntry(ENABLED_ENTRY_TYPE, { on: false });
    await teardown();
  }

  // Initialize the gate on session_start. We can't call setActiveTools
  // during the factory — the extension runtime isn't initialized yet and
  // pi throws "Action methods cannot be called during extension loading".
  // session_start fires after the runtime is up and after the registerTool
  // calls below have settled, so it's the first safe point to flip the
  // browser tools out of the active set.
  //
  // This handler also restores the per-session enable bit: the newest
  // browser-enabled custom entry wins. Survives /reload (the same session
  // replays its entries when the extension re-inits) but not /new (fresh
  // session has no entries, so we default to off).
  pi.on("session_start", async (_event, ctx) => {
    let want = false;
    modeOverride = undefined;
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === MODE_ENTRY_TYPE) {
        const data = entry.data as { headless?: boolean } | undefined;
        if (typeof data?.headless === "boolean") modeOverride = data.headless;
      }
      if (entry.type === "custom" && entry.customType === ENABLED_ENTRY_TYPE) {
        const data = entry.data as { on?: boolean } | undefined;
        if (data && typeof data.on === "boolean") want = data.on;
      }
    }
    await serialize(async () => { gateReady = true; setEnabled(want); }, true);
  });

  pi.on("session_shutdown", async () => {
    await serialize(async () => { stopped = true; await teardown(); }, true);
  });

  pi.registerTool({
    name: "browser_run",
    label: "Browser Run",
    description: "Execute a validated v1 workflow atomically, from an explicit fresh or persistent profile. Prefer reviewed named workflows for credentials; inline values may persist in tool history. No retries or rollback.",
    promptSnippet: "Run reviewed browser workflows in one invocation; use primitive tools for diagnostics.",
    parameters: Type.Object({
      workflow: Type.Optional(Type.Any()),
      name: Type.Optional(Type.String()),
      parameters: Type.Optional(Type.Record(Type.String(), Type.Any())),
    }),
    async execute(_id, params, signal, _update, ctx) {
      const root = ctx.cwd;
      const invocation = Date.now();
      let workflow;
      try {
        if (Object.keys(params).some(k => !["workflow", "name", "parameters"].includes(k))) throw Error();
        if ((params.workflow === undefined) === (params.name === undefined) ||
            (params.workflow !== undefined && params.parameters !== undefined)) throw Error();
        workflow = params.name ? await bounded(loadWorkflow(root, params.name, params.parameters), 5000, signal) : validateWorkflow(params.workflow);
      } catch {
        const details = { version: 1, category: signal?.aborted ? "canceled" : "invalid-workflow" };
        return { content: [{ type: "text", text: JSON.stringify(details) }], details, isError: true };
      }
      const deadline = invocation + (workflow.overallMs ?? LIMITS.overallMs);
      let abandoned = false;
      let started = false;
      let notifyStarted!: () => void;
      const hasStarted = new Promise<void>(resolve => { notifyStarted = resolve; });
      const queued = serialize(async () => {
        started = true; notifyStarted();
        if (abandoned || signal?.aborted || Date.now() >= deadline) return { version: 1, category: signal?.aborted ? "canceled" : "timeout" };
        const details = await runWorkflow(workflow, { signal, deadline, headless: isHeadless(), diagnosticProfile: profileDir, poison: () => { poisoned = true; } });
        details.source = params.name ? { kind: "named", name: params.name } : { kind: "inline" };
        details.queueWaitMs = Math.max(0, Date.now() - invocation - details.durationMs);
        return details;
      });
      queued.catch(() => { notifyStarted(); });
      let details;
      try {
        try { await bounded(hasStarted, Math.max(1, deadline - Date.now()), signal); }
        catch { if (!started) { abandoned = true; return { content: [{ type: "text", text: signal?.aborted ? "canceled" : "timeout" }], details: { version: 1, category: signal?.aborted ? "canceled" : "timeout" }, isError: true }; } }
        details = await queued;
      } catch {
        details = { version: 1, category: poisoned ? "restart-required" : "unavailable" };
      }
      return { content: [{ type: "text", text: JSON.stringify(details) }], details, isError: details.category !== "success" };
    },
  });

  pi.registerTool({
    name: "browser_goto",
    label: "Browser Goto",
    description:
      "Navigate the persistent Browser to a URL. Returns final URL and HTTP status. Cookies + localStorage persist across calls.",
    promptSnippet:
      "Open a URL in a persistent browser to inspect a live web app's DOM, storage, network, and console — instead of asking the user to copy from devtools",
    promptGuidelines: [
      "When debugging a frontend issue (broken auth, failed requests, missing tokens, JS errors, form not working, blank screen), prefer driving the live app with browser_goto + browser_eval + browser_console + browser_network instead of asking the user to copy-paste from devtools.",
      "When the user reports 'works in browser, fails here' or 'I tried X and it didn't work', use browser_goto to reproduce the exact flow yourself before forming a hypothesis from source alone.",
      "After making a frontend change, use browser_goto plus browser_click / browser_fill to actually exercise the fix end-to-end before declaring it done — don't rely on the user to verify.",
    ],
    parameters: Type.Object({
      url: Type.String({ description: "URL to navigate to" }),
      waitUntil: Type.Optional(
        Type.Union([
          Type.Literal("load"),
          Type.Literal("domcontentloaded"),
          Type.Literal("networkidle"),
          Type.Literal("commit"),
        ]),
      ),
      timeoutMs: Type.Optional(Type.Number()),
    }),
    async execute(_id, params) {
      return serialize(async () => {
        const p = await ensurePage();
        const resp = await p.goto(params.url, {
          waitUntil: params.waitUntil ?? "domcontentloaded",
          timeout: params.timeoutMs ?? 30_000,
        });
        const status = resp?.status();
        return {
          content: [
            { type: "text", text: `${status ?? "?"} ${p.url()}` },
          ],
          details: { status, finalUrl: p.url() },
        };
      });
    },
  });

  pi.registerTool({
    name: "browser_eval",
    label: "Browser Eval",
    description:
      "Evaluate JS in the current page. Pass an expression ('localStorage.length'), a function ('() => Object.keys(localStorage)', 'async () => { ... }'), or an already-called IIFE — all three forms work. Return value must be JSON-serializable; for DOM nodes return primitive properties (.outerHTML, .textContent, .value) rather than the node itself.",
    promptSnippet:
      "Run JS in the live page to read localStorage / cookies, decode a JWT, inspect form or component state, or fire a fetch with custom headers",
    promptGuidelines: [
      "Use browser_eval to inspect runtime state (localStorage, cookies, in-page variables, JWT contents, computed styles) instead of guessing from source.",
    ],
    parameters: Type.Object({
      expression: Type.String({ description: "Expression or function source" }),
    }),
    async execute(_id, params) {
      return serialize(async () => {
        const p = await ensurePage();
        // Playwright's evaluate(string) treats the string as an expression.
        // A user-written `() => foo` therefore evaluates to a function *value*
        // rather than calling it.
        //
        // Previous attempt: a regex that detected arrow/function shapes and
        // wrapped them in `(<src>)()`. That double-wrapped already-called
        // IIFEs like `(() => 42)()` into `((() => 42)())()` → `42()` → TypeError.
        //
        // Robust approach: ask the page itself. Evaluate the source once,
        // and if the result is a function, call it. This handles all three
        // forms (plain expr, function value, IIFE) without ambiguity.
        const src = params.expression;
        const wrapped = `(() => { const __v = (${src}); return typeof __v === 'function' ? __v() : __v; })()`;
        try {
          const result = await p.evaluate(wrapped);
          const text =
            typeof result === "string"
              ? result
              : (JSON.stringify(result, null, 2) ?? String(result));
          return { content: [{ type: "text", text }], details: { result } };
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          // Keep the success/error result shape identical so the tool's
          // inferred return type stays a single union member — the error
          // text already lives in `content[].text`, no need to duplicate it
          // into details.
          return {
            content: [{ type: "text", text: `eval error: ${msg}` }],
            details: { result: undefined },
            isError: true,
          };
        }
      });
    },
  });

  pi.registerTool({
    name: "browser_console",
    label: "Browser Console",
    description:
      "Drain buffered console + pageerror entries (oldest first). With clear=true (default) the ENTIRE buffer is wiped after read, not just the entries returned — this is intentional, so subsequent calls observe a fresh window of activity rather than re-walking the same noise. Pass clear=false to peek without draining.",
    promptSnippet:
      "Read JS errors and console output captured since last drain — reach for this whenever a page seems broken without an obvious network cause",
    parameters: Type.Object({
      limit: Type.Optional(Type.Number({ description: "Max entries (default 100)" })),
      filter: Type.Optional(
        Type.String({ description: "Only entries whose text/location contains this substring" }),
      ),
      clear: Type.Optional(
        Type.Boolean({
          description:
            "Clear the entire buffer after read (not just returned entries). Default true.",
        }),
      ),
    }),
    async execute(_id, params) {
      return serialize(async () => {
        const limit = params.limit ?? 100;
        const filter = params.filter;
        const filtered = filter
          ? consoleBuf.filter(
              (e) => e.text.includes(filter) || (e.location ?? "").includes(filter),
            )
          : consoleBuf.slice();
        const out = limit > 0 ? filtered.slice(-limit) : [];
        if (params.clear ?? true) consoleBuf.length = 0;
        const text =
          out
            .map(
              (e) =>
                `[${new Date(e.ts).toISOString()}] ${e.type}: ${e.text}${e.location ? `  @ ${e.location}` : ""}`,
            )
            .join("\n") || "(empty)";
        return { content: [{ type: "text", text }], details: { entries: out } };
      });
    },
  });

  pi.registerTool({
    name: "browser_network",
    label: "Browser Network",
    promptSnippet:
      "Inspect the actual HTTP requests the page made — status, method, URL, and (with verbose=true) Authorization / apikey / content-type headers. Use for 401 / 403 / CORS debugging",
    promptGuidelines: [
      "Use browser_network with verbose=true (and urlFilter to narrow scope) for any auth or CORS issue — it reveals the exact Authorization / apikey / Origin / content-type headers the browser actually sent, which is otherwise invisible from source.",
    ],
    description:
      "Drain buffered network requests. Default text output is one terse line per request ('<status> <method> <url>') to keep context small.\n\nOpt-in for headers: set verbose=true to inline a curated set of request/response headers on each returned row (authorization, apikey, content-type, x-client-info, accept-profile, content-profile, prefer, location, www-authenticate, retry-after). Pass includeHeaders=['cookie','cache-control',...] to add more for this call only (case-insensitive). Best paired with urlFilter / status so headers only appear on the rows you care about.\n\nClear semantics: with clear=true (default) the ENTIRE buffer is wiped after read, not just the returned entries — this is intentional, so subsequent calls observe a fresh window of activity rather than re-walking the same subresource noise. Pass clear=false to peek without draining.",
    parameters: Type.Object({
      limit: Type.Optional(Type.Number()),
      urlFilter: Type.Optional(Type.String({ description: "Substring filter on URL" })),
      status: Type.Optional(Type.Number({ description: "Exact HTTP status to match" })),
      verbose: Type.Optional(
        Type.Boolean({
          description:
            "Inline a curated set of request/response headers on each row. Off by default to keep context small.",
        }),
      ),
      includeHeaders: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Extra header names (case-insensitive) to surface alongside the curated default set. Implies verbose=true.",
        }),
      ),
      clear: Type.Optional(
        Type.Boolean({
          description:
            "Clear the entire buffer after read (not just returned entries). Default true.",
        }),
      ),
    }),
    async execute(_id, params) {
      return serialize(async () => {
        let entries = netBuf.slice();
        if (params.urlFilter) {
          const needle = params.urlFilter;
          entries = entries.filter((e) => e.url.includes(needle));
        }
        if (params.status != null) {
          const wanted = params.status;
          entries = entries.filter((e) => e.status === wanted);
        }
        const limit = params.limit ?? 100;
        const out = limit > 0 ? entries.slice(-limit) : [];
        if (params.clear ?? true) netBuf.length = 0;

        const extra = (params.includeHeaders ?? []).map((h: string) => h.toLowerCase());
        const showHeaders = params.verbose === true || extra.length > 0;
        const allow = new Set([...KEEP_HEADERS, ...extra]);

        const lines: string[] = [];
        for (const e of out) {
          lines.push(
            `${e.status ?? "ERR"} ${e.method} ${e.url}${e.failure ? `  (${e.failure})` : ""}`,
          );
          if (showHeaders) {
            const reqH = e.requestHeaders ? filterHeaders(e.requestHeaders, allow) : {};
            for (const [k, v] of Object.entries(reqH)) lines.push(`  → ${k}: ${v}`);
            const resH = e.responseHeaders ? filterHeaders(e.responseHeaders, allow) : {};
            for (const [k, v] of Object.entries(resH)) lines.push(`  ← ${k}: ${v}`);
          }
        }
        const text = lines.join("\n") || "(empty)";
        return { content: [{ type: "text", text }], details: { entries: out } };
      });
    },
  });

  pi.registerTool({
    name: "browser_fill",
    label: "Browser Fill",
    description: "Type a value into the input matching the selector.",
    promptSnippet:
      "Type into an input on the live page (dispatches input / change events properly, unlike a raw .value= assignment)",
    parameters: Type.Object({
      selector: Type.String(),
      value: Type.String(),
    }),
    async execute(_id, params) {
      return serialize(async () => {
        const p = await ensurePage();
        await p.fill(params.selector, params.value);
        return {
          content: [{ type: "text", text: `filled ${params.selector}` }],
          details: {},
        };
      });
    },
  });

  pi.registerTool({
    name: "browser_click",
    label: "Browser Click",
    description:
      "Click the element matching the selector. CSS selectors and Playwright text= / role= selectors supported. Note: CSS attribute selectors match HTML attributes, not DOM properties — e.g. `button[type=submit]` will NOT match `<button>Submit</button>` even though that button's DOM `.type === 'submit'` by default. For semantic matching prefer `text=Submit` or `role=button[name=Submit]`.",
    promptSnippet:
      "Click an element on the live page — drives the app the way a user would, including form submits and SPA navigations",
    parameters: Type.Object({
      selector: Type.String(),
    }),
    async execute(_id, params) {
      return serialize(async () => {
        const p = await ensurePage();
        await p.click(params.selector);
        return {
          content: [{ type: "text", text: `clicked ${params.selector}` }],
          details: {},
        };
      });
    },
  });

  pi.registerTool({
    name: "browser_screenshot",
    label: "Browser Screenshot",
    description:
      "Save a PNG screenshot to a temp file and return its path. Use the read tool on that path to view it (separate step so vision-token cost is paid only when you choose).",
    promptSnippet:
      "Capture a PNG of the current page when DOM / state inspection isn't enough and you need to see the visual",
    parameters: Type.Object({
      fullPage: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params) {
      return serialize(async () => {
        const p = await ensurePage();
        const dir = mkdtempSync(join(tmpdir(), "pi-browser-"));
        const file = join(dir, "screenshot.png");
        await p.screenshot({ path: file, fullPage: params.fullPage ?? false, type: "png" });
        return {
          content: [{ type: "text", text: file }],
          details: { path: file },
        };
      });
    },
  });

  pi.registerTool({
    name: "browser_close",
    label: "Browser Close",
    description: "Close the persistent browser context. Next browser_* call relaunches.",
    promptSnippet:
      "Tear down the browser (rarely needed; auto-cleans on session end)",
    parameters: Type.Object({}),
    async execute() {
      return serialize(async () => {
        await teardown();
        return { content: [{ type: "text", text: "browser closed" }], details: {} };
      }, true);
    },
  });

  pi.registerCommand("browser", {
    description:
      "Browser tools: on, off, headed, headless; bare /browser for status and mode",
    handler: async (args, ctx) => {
      const cmd = (args || "").trim().toLowerCase();
      if (cmd === "headed" || cmd === "headless") {
        await serialize(async () => {
          const headless = cmd === "headless";
          if (headless !== isHeadless()) await teardown();
          modeOverride = headless;
          pi.appendEntry(MODE_ENTRY_TYPE, { headless });
          await enable();
        }, true);
        ctx.ui.notify(`browser tools enabled (${cmd})`, "info");
        return;
      }
      if (cmd === "on" || cmd === "enable") {
        await serialize(enable, true);
        ctx.ui.notify(`browser tools enabled (${isHeadless() ? "headless" : "headed"})`, "info");
        return;
      }
      if (cmd === "off" || cmd === "disable" || cmd === "close" || cmd === "kill") {
        const wasRunning = !!(page && !page.isClosed());
        await serialize(disable, true);
        ctx.ui.notify(
          wasRunning ? "browser tools disabled, browser closed" : "browser tools disabled",
          "info",
        );
        return;
      }
      // Bare /browser — status.
      const toolState = enabled ? "enabled" : "disabled (run /browser on)";
      const procState =
        page && !page.isClosed() ? `, open at ${page.url()}` : "";
      ctx.ui.notify(`browser tools: ${toolState}, ${isHeadless() ? "headless" : "headed"}${procState}`, "info");
    },
  });

  // Default-off gate: tools stay registered (visible in pi.getAllTools(),
  // command discovery normal) but their promptSnippet / promptGuidelines
  // drop out of the system prompt and they're not callable until
  // /browser on adds them back. The actual setActiveTools call happens in
  // the session_start handler above, because pi forbids action methods
  // during the factory.
}
