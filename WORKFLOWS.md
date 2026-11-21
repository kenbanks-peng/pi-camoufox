# Browser workflows (v1)

Enable with /browser on, then prefer browser_run for procedures; retain browser_goto,
browser_eval, console/network and other primitives as diagnostic escape hatches.
Runtime setup is unchanged: see runtime/README.md. No browser downloads are implicit.

Inline arguments:
```json
{"workflow":{"version":1,"start":{"mode":"fresh"},"steps":[
  {"action":"goto","url":"http://127.0.0.1:8080"},
  {"action":"fill","target":{"label":"Password"},"value":"example-only"},
  {"action":"click","target":{"role":"button","name":"Sign in"}},
  {"action":"expect","kind":"text","target":{"css":"h1"},"value":"Verified"}
]}}
```

Named files live directly in <invocation cwd>/.pi/browser-workflows/<name>.json.
No ancestor/Git-root discovery, recursion, composition, eval, interpolation or hot
reload. The exact file is read once per invocation; names contain only letters,
digits, underscores and hyphens. Symlink escapes are rejected.

Example login.json (serve the local fixture in test/workflow-integration.test.mjs):
```json
{"version":1,"parameters":[{"name":"password","type":"string","secret":true}],
 "workflow":{"version":1,"start":{"mode":"fresh"},"steps":[
 {"action":"goto","url":"http://127.0.0.1:8080"},
 {"action":"fill","target":{"label":"Password"},"value":{"$param":"password"}},
 {"action":"click","target":{"role":"button","name":"Sign in"}},
 {"action":"expect","kind":"text","target":{"css":"h1"},"value":"Verified"}]}}
```
Invoke with {"name":"login","parameters":{"password":{"env":"LOGIN_PASSWORD"}}}.
Parameters are required, strictly typed string/number/boolean values; extras and
duplicate declarations fail. References replace whole values only. Secret inputs
must be environment references and can only feed fill values. The extension
process must inherit the variable; environment storage is not a credential vault.

All fill values, including inline literals, are omitted from reports and identity
hashes. Credentials passed directly as tool arguments may persist in conversation
or session history; safe reports cannot erase that history. Use named env secrets.

Targets select exactly one of role (optional name), label, testId or css. Semantic
matching is literal, case-sensitive, exact, not regex/glob. Playwright normalizes
whitespace for names/text; text assertions collapse whitespace and trim.
URL assertions match the complete URL including query/fragment. CSS is an explicit
escape hatch. Duplicate matches fail; absent actions time out. Assertions support
url/text/visible/enabled/checked. Only visible=false accepts an absent element.
Other assertions require exactly one element; no first-match fallback.

Starting mode is mandatory: fresh owns a temporary profile deleted after confirmed
shutdown; persistent requires an existing absolute selected profile directory and
never deletes it. The diagnostic profile cannot be selected. Browser-native
profile ownership locks reject concurrent use. Diagnostic state remains separate.
Viewport remains 1280x800. Neither persistent storage nor these workflows promise
a stable fingerprint or deterministic external websites.

Limits: 64 KiB resolved definition, 100 steps, 8192 characters per string;
step default 10s (max 30s), overall default 120s (max 300s).
Queue wait, loading, helper preparation, launch and actions count toward overall
time. Named loading has a 5s cap. Evidence and context cleanup each have a separate
5s budget. First failure stops execution; no action retries, sleeps or rollback
steps. Atomic means queue exclusivity, not transactional rollback. Cancellation
cannot undo an already dispatched external action. A queued canceled/expired run
returns promptly without preempting existing primitives and never later launches.

Reports contain categories, step indices, ordered durations, nonsecret settings,
fill-independent workflow identity, and runtime versions. Raw errors, call logs,
URLs, headers, content and console text are omitted. Navigation failures report
`dns-failed` for recognized Firefox host/proxy resolution errors and `network-failed`
for recognized connection, offline and transport errors. Unknown errors remain
`execution-failed`; raw messages are never included. Console evidence is counts
by normalized severity; network is limited to 32 method/status/resource-type rows.

Artifacts default off. Set artifacts: {"screenshot":true,"trace":true} inside the
workflow only with explicit consent: screenshots/traces can contain secrets and
are NOT redacted. Tracing begins before actions. Success discards artifacts;
failure retains private temporary directories with files restricted to owner
access, with a 16 MiB retained-file limit. Delete returned directories manually
when finished; there is no automatic retention service. Capture failures cannot
replace the primary failure.

Unconfirmed launch/cleanup termination fails closed for the current extension
instance. Use a fresh extension/session instance, but restarting does not prove
the previous process stopped. Retained potentially owned profiles must not be
reused/deleted until termination is independently confirmed. There is no reset API.
