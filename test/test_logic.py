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

print("\n_fetch_github_code — fails CLOSED, never silently degrades")
TREE = json.dumps({"tree": [
    {"type": "blob", "path": "README.md", "size": 100},
    {"type": "blob", "path": "main.py", "size": 100},
    {"type": "blob", "path": "src/app.ts", "size": 100},
    {"type": "blob", "path": "src/extra.ts", "size": 100},
]}).encode()

# A non-GitHub URL must never reach the API path — it returns "" so the caller
# renders the page, and leader and validators all take that same branch.
check("non-github short-circuits", pw._fetch_github_code("https://gitlab.com/a/b"), "")

# Happy path: README + MAX_SOURCE_FILES source files, shallowest first.
# Fixtures are multi-line on purpose: a file under MIN_SOURCE_LINES is treated
# as generated, so one-liners here would test the minification rule by accident
# rather than the happy path.
_stub_routes([
    ("api.github.com", _Resp(200, TREE)),
    ("README.md", _Resp(200, b"# Widget\nDoes a thing.")),
    ("main.py", _Resp(200, b"import sys\n\n\ndef main():\n    print('hi')\n")),
    ("src/app.ts", _Resp(200, b"export const a = 1\nexport const b = 2\nexport const c = 3\n")),
    ("src/extra.ts", _Resp(200, b"export const d = 4\nexport const e = 5\nexport const f = 6\n")),
])
code = pw._fetch_github_code("https://github.com/acme/widget")
check("README included", "// FILE: README.md" in code, True)
check("shallowest source included", "// FILE: main.py" in code, True)
check("second source included", "// FILE: src/app.ts" in code, True)
check("budget capped at 2 files", "// FILE: src/extra.ts" in code, False)
check("real content reaches the prompt", "print('hi')" in code, True)
check("no Response repr leaks in", "Response(" in code, False)

# An unmarked bundle is only detectable once fetched, so it must be skipped
# past rather than filling a slot with one unreadable line.
BUNDLE_TREE = json.dumps({"tree": [
    {"type": "blob", "path": "README.md", "size": 100},
    {"type": "blob", "path": "bundle.js", "size": 900},
    {"type": "blob", "path": "src/app.ts", "size": 100},
    {"type": "blob", "path": "src/util.ts", "size": 100},
]}).encode()
_stub_routes([
    ("api.github.com", _Resp(200, BUNDLE_TREE)),
    ("README.md", _Resp(200, b"# Widget")),
    ("bundle.js", _Resp(200, b"!function(){" + b"z" * 900 + b"}();")),
    ("src/app.ts", _Resp(200, b"export const a = 1\nexport const b = 2\nexport const c = 3\n")),
    ("src/util.ts", _Resp(200, b"export const d = 4\nexport const e = 5\nexport const f = 6\n")),
])
code = pw._fetch_github_code("https://github.com/acme/bundled")
check("bundle excluded from prompt", "// FILE: bundle.js" in code, False)
check("real source used instead", "// FILE: src/app.ts" in code, True)
check("no minified payload leaks in", "z" * 100 in code, False)

# The spare attempt is exactly one: two bundles ahead of real source exhausts
# MAX_FILE_FETCHES and the good file is never reached.
TWO_BUNDLES = json.dumps({"tree": [
    {"type": "blob", "path": "a-bundle.js", "size": 900},
    {"type": "blob", "path": "b-bundle.js", "size": 900},
    {"type": "blob", "path": "c-bundle.js", "size": 900},
    {"type": "blob", "path": "real.ts", "size": 100},
]}).encode()
_stub_routes([
    ("api.github.com", _Resp(200, TWO_BUNDLES)),
    ("bundle.js", _Resp(200, b"!function(){" + b"z" * 900 + b"}();")),
    ("real.ts", _Resp(200, b"const a = 1\nconst b = 2\nconst c = 3\n")),
])
try:
    out = pw._fetch_github_code("https://github.com/acme/allbundles")
    check("budget is a hard stop, not best-effort", "// FILE: real.ts" in out, False)
except UserError as e:
    # Also acceptable: nothing showable was found at all.
    assert e.message.startswith("[EXTERNAL]"), e.message
    print("  ok   all-bundles repo -> EXTERNAL")

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
    print(f"  ok   404 both    -> {e.message[:34]}")

# main 404s, master serves — the fallback branch must still work.
_stub_routes([
    ("trees/main", _Resp(404, b"Not Found")),
    ("trees/master", _Resp(200, TREE)),
    ("README.md", _Resp(200, b"# Old repo")),
    ("main.py", _Resp(200, b"x = 1")),
    ("src/app.ts", _Resp(200, b"y = 2")),
])
check("falls back to master branch",
      "// FILE: README.md" in pw._fetch_github_code("https://github.com/acme/legacy"), True)

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
