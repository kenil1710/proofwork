"""
Offline check of the deterministic half of verify_milestone.

Stubs the `genlayer` module so the contract imports outside GenVM, then
exercises score parsing, the weighted roll-up, evidence fingerprinting and the
validator's accept/reject rule — none of which need a network or a validator
set. Runs in milliseconds; a real verification costs 400s+ on Bradbury.

    python3 test/test_logic.py

Note the stub needs `gl.public.write` to carry a `.payable` attribute, since
`create_job` is decorated `@gl.public.write.payable`.
"""
import sys, types, json, pathlib, importlib.util

# ── stub the genlayer module ────────────────────────────────────────────────
gl_mod = types.ModuleType("genlayer")


class UserError(Exception):
    def __init__(self, message):
        super().__init__(message)
        self.message = message


class _VM:
    UserError = UserError
    Return = type("Return", (), {})
    Result = type("Result", (), {})

    @staticmethod
    def run_nondet(*a, **k):
        raise NotImplementedError


class _GL:
    vm = _VM()
    nondet = types.SimpleNamespace()
    storage = types.SimpleNamespace()
    evm = types.SimpleNamespace(contract_interface=lambda c: c)
    # gl.public.write is used both as @gl.public.write and @gl.public.write.payable
    write = type("_W", (), {"__call__": staticmethod(lambda f: f),
                            "payable": staticmethod(lambda f: f)})()
    public = types.SimpleNamespace(write=write, view=lambda f: f)
    message = types.SimpleNamespace()
    Contract = object


gl_mod.gl = _GL()
gl_mod.allow_storage = lambda c: c
for name in ("u32", "u64", "u256"):
    setattr(gl_mod, name, int)
gl_mod.Address = str
gl_mod.TreeMap = dict
gl_mod.DynArray = list
gl_mod.__all__ = [
    "gl", "allow_storage", "u32", "u64", "u256", "Address", "TreeMap", "DynArray",
]
sys.modules["genlayer"] = gl_mod

spec = importlib.util.spec_from_file_location(
    "pw", str(pathlib.Path(__file__).resolve().parent.parent / "contracts" / "proof_work.py")
)
pw = importlib.util.module_from_spec(spec)
spec.loader.exec_module(pw)

fails = []


def check(label, got, want):
    if got != want:
        fails.append(f"{label}: got {got!r}, want {want!r}")
        print(f"  FAIL {label}: got {got!r}, want {want!r}")
    else:
        print(f"  ok   {label}")


# The weight branches verify_milestone picks from, by evidence supplied.
W_ALL = {"code": 25, "design": 25, "functionality": 25, "completeness": 25}
W_CODE_ONLY = {"code": 50, "design": 0, "functionality": 0, "completeness": 50}

print("\n_extract_scores — shapes a model actually returns")
clean = '{"code_quality": 85, "design_match": 90, "functionality": 80, "completeness": 88}'
check("clean json", pw._extract_scores(clean, W_ALL),
      {"code": 85, "design": 90, "functionality": 80, "completeness": 88})
check("fenced json", pw._extract_scores("```json\n" + clean + "\n```", W_ALL),
      {"code": 85, "design": 90, "functionality": 80, "completeness": 88})
check("chatty prose", pw._extract_scores("Here you go:\n" + clean + "\nHope that helps!", W_ALL),
      {"code": 85, "design": 90, "functionality": 80, "completeness": 88})
check("dict passthrough", pw._extract_scores(json.loads(clean), W_ALL),
      {"code": 85, "design": 90, "functionality": 80, "completeness": 88})
check("float + string values",
      pw._extract_scores('{"code_quality": 84.6, "design_match": "90", "functionality": " 80 ", "completeness": 88}', W_ALL),
      {"code": 85, "design": 90, "functionality": 80, "completeness": 88})
check("out of range clamps",
      pw._extract_scores('{"code_quality": 130, "design_match": -5, "functionality": 80, "completeness": 88}', W_ALL),
      {"code": 100, "design": 0, "functionality": 80, "completeness": 88})

# A missing axis is only safe when it carries no weight. Under W_CODE_ONLY
# design and functionality are multiplied by zero, so their absence cannot move
# the result and 0 is the honest value.
check("missing ZERO-weight axis -> 0",
      pw._extract_scores('{"code_quality": 85, "completeness": 90}', W_CODE_ONLY),
      {"code": 85, "design": 0, "functionality": 0, "completeness": 90})

# ...but a missing WEIGHTED axis must not silently score 0. This is the exact
# shape that used to cost a freelancer a payout band: three 95s and an omitted
# design_match rolled up to 71 and paid 70% instead of 100%.
try:
    got = pw._extract_scores(
        '{"code_quality": 95, "functionality": 95, "completeness": 95}', W_ALL
    )
    fails.append(f"missing weighted axis should have raised, got {got!r}")
    print(f"  FAIL missing weighted axis did not raise: {got!r}")
except UserError as e:
    assert e.message.startswith("[LLM_ERROR]"), e.message
    assert "design" in e.message, e.message
    print(f"  ok   missing WEIGHTED axis -> {e.message[:52]}")

# Guard the regression directly: had it scored 0, this is what would have paid.
check("the payout that omission would have caused",
      pw._weighted_final({"code": 95, "design": 0, "functionality": 95, "completeness": 95}, W_ALL),
      71)

for bad in ("I cannot evaluate this.", "", "score is high"):
    try:
        pw._extract_scores(bad, W_ALL)
        fails.append(f"no-json {bad!r} should have raised")
        print(f"  FAIL no-json {bad!r} did not raise")
    except UserError as e:
        assert e.message.startswith("[LLM_ERROR]"), e.message
        print(f"  ok   no-json {bad!r} -> LLM_ERROR")

try:
    pw._extract_scores('{"code_quality": "excellent"}', W_CODE_ONLY)
    fails.append("non-numeric should have raised")
except UserError as e:
    print(f"  ok   non-numeric -> {e.message[:40]}")

print("\n_weighted_final")
even = {"code": 25, "design": 25, "functionality": 25, "completeness": 25}
check("all 80s, even weights",
      pw._weighted_final({"code": 80, "design": 80, "functionality": 80, "completeness": 80}, even), 80)
check("zero-weight axis ignored",
      pw._weighted_final({"code": 90, "design": 0, "functionality": 0, "completeness": 90},
                         {"code": 50, "design": 0, "functionality": 0, "completeness": 50}), 90)
check("mixed",
      pw._weighted_final({"code": 90, "design": 70, "functionality": 60, "completeness": 100}, even), 80)

# The old comparative rule (compare weighted finals within a tolerance) is gone:
# validators no longer score at all, because a validator-side LLM call stops the
# transaction committing on Bradbury. What they check now is evidence integrity.

flat = lambda n: {k: n for k in pw.SCORE_KEYS}

print("\n_is_usable_url — evidence present, or a word someone typed")
for good in (
    "https://github.com/acme/widget",
    "http://example.com",
    "https://widget.vercel.app/",
    "https://figma.com/file/abc?node-id=1",
    "https://sub.domain.co.uk/path#frag",
    "https://user:pw@example.com/x",
    "https://example.com:8443/x",
    "https://192.168.1.10/status",
    "  https://example.com  ",
    "HTTPS://EXAMPLE.COM",
):
    check(f"usable: {good.strip()[:38]}", pw._is_usable_url(good), True)

# Every one of these used to read as "evidence supplied". "nope" is the one
# observed live: it flipped the weights to 25/25/25/25 and sent a screenshot
# render at a non-URL, and the milestone settled UNDETERMINED.
for bad in (
    "none", "nope", "n/a", "N/A", "-", "", "   ", "\t",
    "TBD", "no mockup", "null", "undefined", "0",
    "github.com/acme/widget",       # no scheme
    "www.example.com",              # no scheme
    "ftp://example.com/x",          # scheme this contract cannot fetch
    "javascript:alert(1)",
    "file:///etc/passwd",
    "http://",                      # no host
    "https://",
    "http://nope",                  # single bare label, not reachable
    "http://localhost:3000",        # only the submitter can see it
    "http://.com",                  # empty label
    "https://example..com",
    "https://example.com.",         # trailing dot
):
    check(f"absent: {bad.strip()[:38]!r}", pw._is_usable_url(bad), False)

print("\n_parse_github_repo — URL shapes people actually paste")
check("plain repo", pw._parse_github_repo("https://github.com/acme/widget"),
      {"owner": "acme", "repo": "widget", "branch": ""})
check("trailing slash", pw._parse_github_repo("https://github.com/acme/widget/"),
      {"owner": "acme", "repo": "widget", "branch": ""})
check("dot git", pw._parse_github_repo("https://github.com/acme/widget.git"),
      {"owner": "acme", "repo": "widget", "branch": ""})
check("no scheme", pw._parse_github_repo("github.com/acme/widget"),
      {"owner": "acme", "repo": "widget", "branch": ""})
check("www", pw._parse_github_repo("https://www.github.com/acme/widget"),
      {"owner": "acme", "repo": "widget", "branch": ""})
check("http", pw._parse_github_repo("http://github.com/acme/widget"),
      {"owner": "acme", "repo": "widget", "branch": ""})
check("tree branch", pw._parse_github_repo("https://github.com/acme/widget/tree/develop"),
      {"owner": "acme", "repo": "widget", "branch": "develop"})
check("tree branch with path",
      pw._parse_github_repo("https://github.com/acme/widget/tree/develop/src/lib"),
      {"owner": "acme", "repo": "widget", "branch": "develop"})
check("query stripped", pw._parse_github_repo("https://github.com/acme/widget?tab=readme"),
      {"owner": "acme", "repo": "widget", "branch": ""})
check("fragment stripped", pw._parse_github_repo("https://github.com/acme/widget#install"),
      {"owner": "acme", "repo": "widget", "branch": ""})
check("whitespace tolerated", pw._parse_github_repo("  https://github.com/acme/widget  "),
      {"owner": "acme", "repo": "widget", "branch": ""})
# Non-GitHub hosts must fall through to the render path, not be mangled.
check("gitlab -> {}", pw._parse_github_repo("https://gitlab.com/acme/widget"), {})
check("owner only -> {}", pw._parse_github_repo("https://github.com/acme"), {})
check("bare host -> {}", pw._parse_github_repo("https://github.com/"), {})
check("site url -> {}", pw._parse_github_repo("https://widget.vercel.app"), {})
check("none -> {}", pw._parse_github_repo("none"), {})

print("\n_is_source_path")
check("py at root", pw._is_source_path("main.py"), True)
check("tsx nested", pw._is_source_path("src/components/App.tsx"), True)
check("sol", pw._is_source_path("contracts/Escrow.sol"), True)
check("readme is not source", pw._is_source_path("README.md"), False)

# An extension missing from the list is not a near miss — _fetch_github_code
# raises [EXTERNAL] and rejects the whole submission, so every language left
# out is a category of work the platform refuses outright.
for path in (
    "src/Main.java", "app/models/user.rb", "public/index.php", "Program.cs",
    "src/engine.cpp", "src/engine.c", "include/engine.h", "include/engine.hpp",
    "Sources/App.swift", "app/src/Main.kt", "src/Job.scala", "lib/main.dart",
    "src/App.vue", "src/App.svelte", "index.html", "styles/site.css",
    "db/schema.sql", "scripts/deploy.sh",
):
    check(f"accepts {path.rsplit('/', 1)[-1]}", pw._is_source_path(path), True)

# Still excluded — these are not source, and the skip list still applies.
check("md still excluded", pw._is_source_path("docs/guide.md"), False)
check("json still excluded", pw._is_source_path("tsconfig.json"), False)
check("png still excluded", pw._is_source_path("assets/logo.png"), False)
check("css inside dist still dropped", pw._is_source_path("dist/site.css"), False)
check("html in node_modules still dropped",
      pw._is_source_path("node_modules/pkg/index.html"), False)

# Minified assets are now eligible by extension, so they must be excluded by
# name before a request is spent on them.
check("site.min.css dropped", pw._is_source_path("site.min.css"), False)
check("app.min.js dropped", pw._is_source_path("static/app.min.js"), False)
check("jquery.min.js dropped", pw._is_source_path("vendor/jquery.min.js"), False)
check("minify.js is NOT minified", pw._is_source_path("src/minify.js"), True)
check("admin.js survives", pw._is_source_path("src/admin.js"), True)

print("\n_looks_minified — content signals, judged on the whole file")
real = "import os\n\n\ndef main():\n    return os.getcwd()\n"
check("ordinary source", pw._looks_minified(real), False)
check("one enormous line", pw._looks_minified("var a=1;" + "x" * 600), True)
check("long line among short ones",
      pw._looks_minified("ok\nfine\n" + "y" * 600 + "\nmore\n"), True)
check("two lines only", pw._looks_minified("a = 1\nb = 2"), True)
check("three short lines is fine", pw._looks_minified("a = 1\nb = 2\nc = 3"), False)
check("empty", pw._looks_minified(""), True)
check("whitespace only", pw._looks_minified("\n\n   \n"), True)
# 500 is the boundary; 500 passes, 501 does not.
check("exactly 500 chars passes",
      pw._looks_minified("a\nb\n" + "z" * 500 + "\n"), False)
check("501 chars fails", pw._looks_minified("a\nb\n" + "z" * 501 + "\n"), True)
check("node_modules dropped", pw._is_source_path("node_modules/left-pad/index.js"), False)
check("dist dropped", pw._is_source_path("dist/bundle.js"), False)
check("nested build dropped", pw._is_source_path("packages/api/build/out.js"), False)
check("lock file dropped", pw._is_source_path("package-lock.json"), False)
# The skip list matches whole segments — a substring test would eat this one.
check("webbuild/ is NOT build/", pw._is_source_path("webbuild/app.ts"), True)
check("a file named dist.ts survives", pw._is_source_path("src/dist.ts"), True)

print("\n_rank_source_files — deterministic, shallowest first")
tree = [
    {"type": "blob", "path": "src/deep/nested/thing.ts", "size": 100},
    {"type": "blob", "path": "index.ts", "size": 100},
    {"type": "tree", "path": "src", "size": 0},
    {"type": "blob", "path": "README.md", "size": 100},
    {"type": "blob", "path": "src/app.ts", "size": 100},
    {"type": "blob", "path": "node_modules/x/i.js", "size": 100},
    {"type": "blob", "path": "huge.js", "size": 999999},
]
check("ranked shallowest first",
      pw._rank_source_files(tree), ["index.ts", "src/app.ts", "src/deep/nested/thing.ts"])
check("oversized file excluded", "huge.js" in pw._rank_source_files(tree), False)
check("directories excluded", "src" in pw._rank_source_files(tree), False)
# Same tree in a different order must rank identically, or an honest validator
# would fetch different files from the leader and reject valid evidence.
check("order-independent", pw._rank_source_files(list(reversed(tree))),
      pw._rank_source_files(tree))
check("empty tree", pw._rank_source_files([]), [])
check("junk entries ignored", pw._rank_source_files(["nope", None, {}]), [])

print("\n_web_get — web.get returns a Response, not a string")
# The real gl.nondet.web.get hands back a dataclass with `status`, `headers`
# and a BYTES `body`. Stringifying the response object would quietly feed the
# model "Response(status=200, ...)" as if it were source code, which is the
# exact failure FIX 4 exists to remove — so pin the decoding.
class _Resp:
    def __init__(self, status, body):
        self.status = status
        self.headers = {}
        self.body = body


def _stub_get(response):
    """Serve one canned response to every request."""
    pw.gl.nondet.web = types.SimpleNamespace(
        get=lambda url, headers=None: response
    )


def _stub_routes(routes, default=None):
    """Serve by URL substring, so a whole fetch sequence can be scripted."""
    def _get(url, headers=None):
        for fragment, response in routes:
            if fragment in url:
                return response
        return default if default is not None else _Resp(404, b"")
    pw.gl.nondet.web = types.SimpleNamespace(get=_get)


_stub_get(_Resp(200, b"def main():\n    return 1\n"))
check("200 -> decoded body", pw._web_get("https://x/y", {}),
      {"status": 200, "body": "def main():\n    return 1\n"})

_stub_get(_Resp(200, "already text"))
check("str body passes through", pw._web_get("https://x/y", {}),
      {"status": 200, "body": "already text"})

_stub_get(_Resp(404, b"nope"))
check("404 surfaces its status", pw._web_get("https://x/y", {})["status"], 404)

_stub_get(_Resp(200, None))
check("empty body -> ''", pw._web_get("https://x/y", {})["body"], "")

# Invalid UTF-8 must not take down the whole evaluation.
_stub_get(_Resp(200, b"ok \xff\xfe done"))
check("bad utf-8 replaced, not raised",
      pw._web_get("https://x/y", {})["body"].startswith("ok "), True)


def _boom(url, headers=None):
    raise RuntimeError("network down")


pw.gl.nondet.web = types.SimpleNamespace(get=_boom)
check("exception -> status 0", pw._web_get("https://x/y", {}),
      {"status": 0, "body": ""})

print("\n_is_transient_status — retry vs. accept the answer")
check("0 (never completed) transient", pw._is_transient_status(0), True)
check("403 (GitHub rate limit) transient", pw._is_transient_status(403), True)
check("429 transient", pw._is_transient_status(429), True)
check("500 transient", pw._is_transient_status(500), True)
check("503 transient", pw._is_transient_status(503), True)
check("404 is NOT transient", pw._is_transient_status(404), False)
check("200 is NOT transient", pw._is_transient_status(200), False)
check("401 is NOT transient", pw._is_transient_status(401), False)

print("\n_fetch_github_code — raw first, API only as a last resort")
TREE = json.dumps({"tree": [
    {"type": "blob", "path": "README.md", "size": 100},
    {"type": "blob", "path": "main.py", "size": 100},
    {"type": "blob", "path": "src/app.ts", "size": 100},
    {"type": "blob", "path": "src/extra.ts", "size": 100},
]}).encode()

# The probe list is ordered JS-first, so the ceiling must clear the whole list
# plus the one README attempt. Below that it does not degrade gracefully: it
# spends the budget missing on React paths and never reaches main.py, and every
# Python/Go/Rust repo would score as though it contained no code.
check("probe ceiling clears the whole list",
      pw.MAX_RAW_PROBES >= 1 + len(pw.RAW_PROBE_PATHS), True)
check(".jsx entrypoints are probed",
      any(p.endswith(".jsx") for p in pw.RAW_PROBE_PATHS), True)
# The listing walk must NOT share the speculative probe counter. If it did, a
# repo whose README answered and whose every probe missed would arrive at the
# listing with the budget spent and fetch nothing from it — README-only evidence,
# which is the failure the listing exists to prevent.
check("listing has its own budget",
      pw.MAX_LISTING_FETCHES >= pw.MAX_SOURCE_FILES, True)
check("one ref, no branch guessing", pw.GITHUB_DEFAULT_REF, "HEAD")

# A non-GitHub URL must never reach either path — it returns "" so the caller
# renders the page, and leader and validators all take that same branch.
check("non-github short-circuits", pw._fetch_github_code("https://gitlab.com/a/b"), "")


def _run_counting(routes, url="https://github.com/acme/widget"):
    """Run a fetch and report how many api.github.com requests it made.

    The metered surface is the only one that matters: raw is CDN-served and
    unmetered, api.github.com is 60/hr per IP on shared validator egress.
    """
    calls = {"api": 0, "raw": 0}

    def _get(u, headers=None):
        calls["api" if "api.github.com" in u else "raw"] += 1
        for fragment, response in routes:
            if fragment in u:
                return response
        return _Resp(404, b"")

    pw.gl.nondet.web = types.SimpleNamespace(get=_get)
    try:
        return pw._fetch_github_code(url), calls
    except UserError as e:
        return f"RAISED:{e.message}", calls


PY_SRC = b"import sys\n\n\ndef main():\n    print('hi')\n"
TS_SRC = b"export const a = 1\nexport const b = 2\nexport const c = 3\n"

# Conventional repo: served entirely from raw, ZERO metered API calls. Every
# raw URL carries the HEAD ref, which GitHub resolves to the default branch —
# so these routes assert the ref as well as the content.
code, calls = _run_counting([
    ("/HEAD/README.md", _Resp(200, b"# Widget\nDoes a thing.")),
    ("/HEAD/src/index.ts", _Resp(200, TS_SRC)),
    ("/HEAD/main.py", _Resp(200, PY_SRC)),
])
check("README included", "// FILE: README.md" in code, True)
check("entrypoint included", "// FILE: src/index.ts" in code, True)
check("second entrypoint included", "// FILE: main.py" in code, True)
check("capped at 2 source files", code.count("// FILE:"), 3)
check("real content reaches the prompt", "print('hi')" in code, True)
check("no Response repr leaks in", "Response(" in code, False)
check("ZERO api.github.com calls on the happy path", calls["api"], 0)

# A Python repo must reach app.py despite the JS-first probe order.
code, calls = _run_counting([
    ("/HEAD/README.md", _Resp(200, b"# Tool\nA CLI.")),
    ("/HEAD/app.py", _Resp(200, PY_SRC)),
])
check("python repo reaches app.py", "// FILE: app.py" in code, True)
check("python repo needs no API call", calls["api"], 0)

# The default branch is whatever the repo says it is. `main` and `master` were
# guesses; HEAD is the answer. A repo defaulting to `blead`, `develop` or `trunk`
# used to be unreachable by raw entirely — no branch name matched, so the branch
# was never identified and every such repo fell through to the metered listing.
code, calls = _run_counting([
    ("/HEAD/README.md", _Resp(200, b"# Legacy\nOld.")),
    ("/HEAD/main.go", _Resp(200, b"package main\n\nfunc main() {}\n")),
])
check("non-main default branch served via HEAD", "// FILE: main.go" in code, True)
check("non-main default needs no API call", calls["api"], 0)

# An explicit /tree/<branch> URL still pins that branch rather than HEAD — the
# client linked a specific branch and that is the evidence they submitted.
code, calls = _run_counting([
    ("/develop/README.md", _Resp(200, b"# Feature branch")),
    ("/develop/main.py", _Resp(200, PY_SRC)),
], url="https://github.com/acme/widget/tree/develop")
check("pinned branch overrides HEAD", "// FILE: main.py" in code, True)
check("pinned branch needs no API call", calls["api"], 0)

# FIX: a repo whose README is not spelled README.md. The branch used to be
# identified by whichever name served README.md, so README.rst meant "no branch
# found" and the whole repo was pushed onto the API path that 403s from
# validator egress. Now the source is read directly and the missing README costs
# only its own paragraph.
code, calls = _run_counting([
    ("/HEAD/README.rst", _Resp(200, b"Widget\n======\n")),
    ("/HEAD/main.py", _Resp(200, PY_SRC)),
])
check("README.rst repo still yields source", "// FILE: main.py" in code, True)
check("README.rst repo needs no API call", calls["api"], 0)

# Same for a repo with no README at all: nothing about it blocks source probing.
code, calls = _run_counting([
    ("/HEAD/index.js", _Resp(200, b"const a = 1\nconst b = 2\nconst c = 3\n")),
])
check("README-less repo still yields source", "// FILE: index.js" in code, True)
check("README-less repo needs no API call", calls["api"], 0)

# No README and nothing at a guessed entrypoint -> ONE listing call. `main.py`
# is deliberately left unrouted: it is in RAW_PROBE_PATHS, so serving it would
# satisfy pass 1 and this fixture would stop exercising the listing at all.
code, calls = _run_counting([
    ("api.github.com", _Resp(200, TREE)),
    ("/HEAD/src/app.ts", _Resp(200, TS_SRC)),
    ("/HEAD/src/extra.ts", _Resp(200, TS_SRC)),
])
check("falls back to the listing", "// FILE: src/app.ts" in code, True)
check("listing walks past the 404 to the next candidate",
      "// FILE: src/extra.ts" in code, True)
check("listing is capped at ONE call", calls["api"], 1)

# The 403 that motivated all of this: unreachable API, but raw still serves.
code, calls = _run_counting([
    ("api.github.com", _Resp(403, b"rate limit exceeded")),
    ("/HEAD/README.md", _Resp(200, b"# Widget\nDoes a thing.")),
    ("/HEAD/main.py", _Resp(200, PY_SRC)),
])
check("API 403 is irrelevant when raw works", "// FILE: main.py" in code, True)
check("API never even called", calls["api"], 0)

print("\n_fetch_github_code — a README is not code (job 16)")
# Django/Rails/Maven/monorepo/cmd-server layouts: a README at the root and no
# source at any guessed path. The old gate was `not pieces`, so the README alone
# satisfied it, the listing never ran, and the model was asked to score
# code_quality having been shown nothing but prose — job 16 scored 0 there and
# the milestone was rejected at 45 on evidence no validator ever saw.
DJANGO_TREE = json.dumps({"tree": [
    {"type": "blob", "path": "README.md", "size": 100},
    {"type": "blob", "path": "manage.py", "size": 100},
    {"type": "blob", "path": "shop/views.py", "size": 100},
]}).encode()
code, calls = _run_counting([
    ("api.github.com", _Resp(200, DJANGO_TREE)),
    ("/HEAD/README.md", _Resp(200, b"# Shop\nA Django storefront.")),
    ("/HEAD/manage.py", _Resp(200, PY_SRC)),
    ("/HEAD/shop/views.py", _Resp(200, PY_SRC)),
], url="https://github.com/acme/shop")
check("README alone no longer suppresses the listing", calls["api"], 1)
check("unguessed source is reached", "// FILE: manage.py" in code, True)
check("second unguessed file too", "// FILE: shop/views.py" in code, True)
# The listing's _find_readme would otherwise re-fetch the same prose and spend
# the budget on it twice.
check("README not duplicated", code.count("// FILE: README.md"), 1)

# The budget bug this created: the README answers, then all eleven probes miss,
# so the speculative counter is spent by the time the listing runs. Sharing one
# counter made the walk break on its first iteration and return the README
# alone — reintroducing the exact failure through the back door.
DEEP_TREE = json.dumps({"tree": [
    {"type": "blob", "path": "packages/api/src/server.ts", "size": 100},
]}).encode()
code, calls = _run_counting([
    ("api.github.com", _Resp(200, DEEP_TREE)),
    ("/HEAD/README.md", _Resp(200, b"# Monorepo\nTurbo workspace.")),
    ("/HEAD/packages/api/src/server.ts", _Resp(200, TS_SRC)),
], url="https://github.com/acme/mono")
check("exhausted probe budget does not starve the listing",
      "// FILE: packages/api/src/server.ts" in code, True)

# A README plus an unreadable listing must NOT be scored as code. Reverting is
# retryable; scoring prose as code_quality rejects the milestone permanently.
_stub_routes([
    ("api.github.com", _Resp(403, b"rate limited")),
    ("/HEAD/README.md", _Resp(200, b"# Shop\nA Django storefront.")),
])
try:
    pw._fetch_github_code("https://github.com/acme/shop")
    fails.append("README + 403 listing should have raised")
    print("  FAIL README + 403 listing did not raise")
except UserError as e:
    assert e.message.startswith("[TRANSIENT]"), e.message
    print(f"  ok   README + 403 -> {e.message[:34]}")

# Source found on raw means the listing is never consulted, so a rate limit
# there cannot turn a good submission into a revert.
code, calls = _run_counting([
    ("api.github.com", _Resp(403, b"rate limited")),
    ("/HEAD/README.md", _Resp(200, b"# Widget")),
    ("/HEAD/main.py", _Resp(200, PY_SRC)),
])
check("source on raw keeps the API out of it entirely", calls["api"], 0)

MINIFIED = b"!function(){" + b"z" * 900 + b"}();"

# An unmarked bundle is only detectable once fetched, so it must be skipped
# past rather than filling a slot with one unreadable line. Here the bundle sits
# at a conventional entrypoint, so it is reached through the raw probe path.
code, calls = _run_counting([
    ("/HEAD/README.md", _Resp(200, b"# Widget\nDoes a thing.")),
    ("/HEAD/src/index.js", _Resp(200, MINIFIED)),
    ("/HEAD/main.py", _Resp(200, PY_SRC)),
], url="https://github.com/acme/bundled")
check("bundle excluded from prompt", "// FILE: src/index.js" in code, False)
check("real source used instead", "// FILE: main.py" in code, True)
check("no minified payload leaks in", "z" * 100 in code, False)
check("skipping a bundle costs no API call", calls["api"], 0)

# Every conventional entrypoint is a bundle, and there is no README, so raw
# yields nothing and the listing runs. Its candidates are bundles too, except
# the last — which the probe budget now comfortably reaches.
TWO_BUNDLES = json.dumps({"tree": [
    {"type": "blob", "path": "a-bundle.js", "size": 900},
    {"type": "blob", "path": "b-bundle.js", "size": 900},
    {"type": "blob", "path": "real.ts", "size": 100},
]}).encode()
code, calls = _run_counting([
    ("api.github.com", _Resp(200, TWO_BUNDLES)),
    ("bundle.js", _Resp(200, MINIFIED)),
    ("real.ts", _Resp(200, b"const a = 1\nconst b = 2\nconst c = 3\n")),
], url="https://github.com/acme/allbundles")
check("bundles skipped, real source still found", "// FILE: real.ts" in code, True)
check("no bundle payload in the prompt", "z" * 100 in code, False)
check("listing still capped at ONE call", calls["api"], 1)

# 403 on the listing is GitHub rate-limiting a validator. It MUST raise, not
# quietly fall back to rendering the landing page — that mismatch is what makes
# an honest validator reject an honest leader.
_stub_routes([("api.github.com", _Resp(403, b"rate limited"))])
try:
    pw._fetch_github_code("https://github.com/acme/widget")
    fails.append("403 on tree should have raised")
    print("  FAIL 403 on tree did not raise")
except UserError as e:
    assert e.message.startswith("[TRANSIENT]"), e.message
    print(f"  ok   403 listing -> {e.message[:34]}")

# 403 partway through, on a file, is the same hazard.
_stub_routes([
    ("api.github.com", _Resp(200, TREE)),
    ("README.md", _Resp(200, b"# Widget")),
    ("main.py", _Resp(403, b"rate limited")),
])
try:
    pw._fetch_github_code("https://github.com/acme/widget")
    fails.append("403 on a file should have raised")
    print("  FAIL 403 on a file did not raise")
except UserError as e:
    assert e.message.startswith("[TRANSIENT]"), e.message
    print(f"  ok   403 file    -> {e.message[:34]}")

_stub_routes([("api.github.com", _Resp(0, b""))])
try:
    pw._fetch_github_code("https://github.com/acme/widget")
    fails.append("network failure should have raised")
except UserError as e:
    assert e.message.startswith("[TRANSIENT]"), e.message
    print(f"  ok   network     -> {e.message[:34]}")

# 404 on both branch names is deterministic — every validator sees it, so the
# messages match exactly and _compare_user_errors counts that as agreement.
_stub_routes([("api.github.com", _Resp(404, b"Not Found"))])
try:
    pw._fetch_github_code("https://github.com/acme/private")
    fails.append("private repo should have raised")
except UserError as e:
    assert e.message.startswith("[EXTERNAL]"), e.message
    # The advice must no longer name a branch: HEAD resolves whatever the
    # default is, so "check the default branch is main or master" would send the
    # client after a problem they do not have.
    assert "master" not in e.message, e.message
    print(f"  ok   404 all     -> {e.message[:34]}")

# A pinned branch that does not exist is the one case where naming a branch is
# the actual diagnosis, and both sides build the identical message from the URL
# alone — required, since _compare_user_errors matches [EXTERNAL] exactly.
try:
    pw._fetch_github_code("https://github.com/acme/widget/tree/nope")
    fails.append("missing pinned branch should have raised")
except UserError as e:
    assert "`nope`" in e.message, e.message
    print(f"  ok   404 pinned  -> ...{e.message[-30:]}")

# The listing is requested at the same single ref as every raw fetch, so leader
# and validators walk one tree. A second `trees/<guess>` call cannot happen.
_stub_routes([
    ("trees/HEAD", _Resp(200, TREE)),
    ("main.py", _Resp(200, b"x = 1\ny = 2\nz = 3\n")),
])
check("listing uses the same ref as the fetches",
      "// FILE: main.py" in pw._fetch_github_code("https://github.com/acme/legacy"), True)

# Readable listing, nothing showable in it.
_stub_routes([
    ("api.github.com", _Resp(200, json.dumps(
        {"tree": [{"type": "blob", "path": "Main.java", "size": 10}]}).encode())),
])
try:
    pw._fetch_github_code("https://github.com/acme/javaonly")
    fails.append("empty result should have raised")
except UserError as e:
    assert e.message.startswith("[EXTERNAL]"), e.message
    print(f"  ok   nothing readable -> {e.message[:29]}")

print("\n_find_readme")
check("shallowest wins", pw._find_readme(tree), "README.md")
check("nested readme found",
      pw._find_readme([{"type": "blob", "path": "docs/readme.rst", "size": 1}]),
      "docs/readme.rst")
check("no readme -> ''", pw._find_readme([{"type": "blob", "path": "a.py", "size": 1}]), "")

print("\nevidence fingerprinting")
check("whitespace collapsed", pw._normalize("a  b\n\tc "), "a b c")
long_page = "Example Domain " * 40
check("fingerprint is bounded", len(pw._fingerprint(long_page)), pw.EVIDENCE_FINGERPRINT_CHARS)
check("fingerprint stable under reformatting",
      pw._fingerprint("Example  Domain\n\nMore info"),
      pw._fingerprint("Example Domain More info"))
check("different pages differ",
      pw._fingerprint("Example Domain") == pw._fingerprint("Totally Other Site"), False)

print("\n_lengths_agree")
check("identical", pw._lengths_agree(1000, 1000), True)
check("within 10%", pw._lengths_agree(1000, 950), True)
check("beyond 10%", pw._lengths_agree(1000, 800), False)
check("tiny page, small abs diff", pw._lengths_agree(20, 60), True)
check("tiny page, big abs diff", pw._lengths_agree(20, 500), False)
check("both empty", pw._lengths_agree(0, 0), True)

print("\n_scores_well_formed")
good = {k: 80 for k in pw.SCORE_KEYS}
check("all present, in range", pw._scores_well_formed(good), True)
check("missing axis rejected", pw._scores_well_formed({"code": 80}), False)
bad_hi = dict(good); bad_hi["code"] = 101
check("above 100 rejected", pw._scores_well_formed(bad_hi), False)
bad_lo = dict(good); bad_lo["design"] = -1
check("below 0 rejected", pw._scores_well_formed(bad_lo), False)

print("\n_evidence_matches — the actual trust boundary")
ev = {"code_fp": "abc page one", "site_fp": "xyz page two", "code_len": 1000, "site_len": 500}
honest = dict(good); honest.update({"code_fp": "abc page one", "site_fp": "xyz page two", "code_len": 1000, "site_len": 500})
check("honest leader accepted", pw._evidence_matches(honest, ev), True)

drifted = dict(honest); drifted["code_len"] = 960
check("page drifted slightly, accepted", pw._evidence_matches(drifted, ev), True)

swapped = dict(honest); swapped["code_fp"] = "a completely different repo"
check("leader swapped the repo, REJECTED", pw._evidence_matches(swapped, ev), False)

invented = dict(honest); invented["site_fp"] = ""
check("leader invented empty evidence, REJECTED", pw._evidence_matches(invented, ev), False)

truncated = dict(honest); truncated["code_len"] = 100
check("leader scored a much smaller page, REJECTED", pw._evidence_matches(truncated, ev), False)

missing = dict(good)
check("leader omitted fingerprints entirely, REJECTED", pw._evidence_matches(missing, ev), False)

print("\n_compare_user_errors")
E = UserError
check("LLM never agrees", pw._compare_user_errors(E("[LLM_ERROR] x"), E("[LLM_ERROR] x")), False)
check("both transient agree", pw._compare_user_errors(E("[TRANSIENT] a"), E("[TRANSIENT] b")), True)
check("same expected agrees", pw._compare_user_errors(E("[EXPECTED] q"), E("[EXPECTED] q")), True)
check("different expected disagrees", pw._compare_user_errors(E("[EXPECTED] q"), E("[EXPECTED] z")), False)
check("external mismatch disagrees", pw._compare_user_errors(E("[EXTERNAL] 404"), E("[EXTERNAL] 500")), False)

print("\n" + ("FAILED: " + "; ".join(fails) if fails else "all passed"))
sys.exit(1 if fails else 0)
