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


def check_scores(label, got, want):
    """Compare the four score axes, ignoring `reasoning`.

    `_extract_scores` also returns the model's written justification, which is
    display-only and never gates a payout. Asserting on it here would couple
    every scoring test to prose."""
    check(label, {k: v for k, v in got.items() if k in pw.SCORE_KEYS}, want)


def check_repo(label, got, want):
    """Compare owner/repo/branch, ignoring `subpath`.

    Cases that are not ABOUT the linked subdirectory should not have to restate
    that it is empty; the ones that are assert on the full dict."""
    check(label, {k: v for k, v in got.items() if k != "subpath"}, want)


# The weight branches verify_milestone picks from, by evidence supplied.
W_ALL = {"code": 25, "design": 25, "functionality": 25, "completeness": 25}
W_CODE_ONLY = {"code": 50, "design": 0, "functionality": 0, "completeness": 50}

print("\n_extract_scores — shapes a model actually returns")
clean = '{"code_quality": 85, "design_match": 90, "functionality": 80, "completeness": 88}'
check_scores("clean json", pw._extract_scores(clean, W_ALL),
      {"code": 85, "design": 90, "functionality": 80, "completeness": 88})
check_scores("fenced json", pw._extract_scores("```json\n" + clean + "\n```", W_ALL),
      {"code": 85, "design": 90, "functionality": 80, "completeness": 88})
check_scores("chatty prose", pw._extract_scores("Here you go:\n" + clean + "\nHope that helps!", W_ALL),
      {"code": 85, "design": 90, "functionality": 80, "completeness": 88})
check_scores("dict passthrough", pw._extract_scores(json.loads(clean), W_ALL),
      {"code": 85, "design": 90, "functionality": 80, "completeness": 88})
check_scores("float + string values",
      pw._extract_scores('{"code_quality": 84.6, "design_match": "90", "functionality": " 80 ", "completeness": 88}', W_ALL),
      {"code": 85, "design": 90, "functionality": 80, "completeness": 88})
check_scores("out of range clamps",
      pw._extract_scores('{"code_quality": 130, "design_match": -5, "functionality": 80, "completeness": 88}', W_ALL),
      {"code": 100, "design": 0, "functionality": 80, "completeness": 88})

# A missing axis is only safe when it carries no weight. Under W_CODE_ONLY
# design and functionality are multiplied by zero, so their absence cannot move
# the result and 0 is the honest value.
check_scores("missing ZERO-weight axis -> 0",
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
check_repo("plain repo", pw._parse_github_repo("https://github.com/acme/widget"),
      {"owner": "acme", "repo": "widget", "branch": ""})
check_repo("trailing slash", pw._parse_github_repo("https://github.com/acme/widget/"),
      {"owner": "acme", "repo": "widget", "branch": ""})
check_repo("dot git", pw._parse_github_repo("https://github.com/acme/widget.git"),
      {"owner": "acme", "repo": "widget", "branch": ""})
check_repo("no scheme", pw._parse_github_repo("github.com/acme/widget"),
      {"owner": "acme", "repo": "widget", "branch": ""})
check_repo("www", pw._parse_github_repo("https://www.github.com/acme/widget"),
      {"owner": "acme", "repo": "widget", "branch": ""})
check_repo("http", pw._parse_github_repo("http://github.com/acme/widget"),
      {"owner": "acme", "repo": "widget", "branch": ""})
check_repo("tree branch", pw._parse_github_repo("https://github.com/acme/widget/tree/develop"),
      {"owner": "acme", "repo": "widget", "branch": "develop"})
# The subpath is the milestone's subject, not decoration — dropping it is what
# handed a Solidity milestone three React pages. See `_parse_github_repo`.
check("tree branch with path",
      pw._parse_github_repo("https://github.com/acme/widget/tree/develop/src/lib"),
      {"owner": "acme", "repo": "widget", "branch": "develop", "subpath": "src/lib"})
check("subpath without tree is not a subpath",
      pw._parse_github_repo("https://github.com/acme/widget/blob/main/x.py").get("subpath"), "")
check("deep subpath kept whole",
      pw._parse_github_repo("https://github.com/a/b/tree/main/packages/core/src").get("subpath"),
      "packages/core/src")
check_repo("query stripped", pw._parse_github_repo("https://github.com/acme/widget?tab=readme"),
      {"owner": "acme", "repo": "widget", "branch": ""})
check_repo("fragment stripped", pw._parse_github_repo("https://github.com/acme/widget#install"),
      {"owner": "acme", "repo": "widget", "branch": ""})
check_repo("whitespace tolerated", pw._parse_github_repo("  https://github.com/acme/widget  "),
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

print("\n_rank_source_files — deterministic, implementation before wrappers")
tree = [
    {"type": "blob", "path": "src/deep/nested/thing.ts", "size": 100},
    {"type": "blob", "path": "index.ts", "size": 100},
    {"type": "tree", "path": "src", "size": 0},
    {"type": "blob", "path": "README.md", "size": 100},
    {"type": "blob", "path": "src/app.ts", "size": 100},
    {"type": "blob", "path": "node_modules/x/i.js", "size": 100},
    {"type": "blob", "path": "huge.js", "size": 999999},
]
# Entry-point stems (`index`, `app`) rank LAST now. The old key was
# (depth, path), which is the reverse of what evidence quality wants: shallow
# means the wrapper, and one level down is where the features live.
check("entry points rank last",
      pw._rank_source_files(tree), ["src/deep/nested/thing.ts", "index.ts", "src/app.ts"])

# The ordering that motivated the rewrite. gm-striker's real shape: two wrappers
# at the conventional paths and every requirement one directory down.
gm_tree = [
    {"type": "blob", "path": "src/App.jsx", "size": 1781},
    {"type": "blob", "path": "src/main.jsx", "size": 1465},
    {"type": "blob", "path": "src/components/GMButton.jsx", "size": 4336},
    {"type": "blob", "path": "src/components/StatsCards.jsx", "size": 2547},
    {"type": "blob", "path": "src/components/Hero.jsx", "size": 334},
    {"type": "blob", "path": "src/config/chain.js", "size": 439},
    {"type": "blob", "path": "vite.config.js", "size": 161},
    {"type": "blob", "path": "src/App.test.jsx", "size": 9000},
]
ranked = pw._rank_source_files(gm_tree)
check("components outrank the entry files",
      ranked[:3], ["src/components/GMButton.jsx",
                   "src/components/StatsCards.jsx",
                   "src/components/Hero.jsx"])
check("larger component first", ranked.index("src/components/GMButton.jsx") <
      ranked.index("src/components/StatsCards.jsx"), True)
# Named config modules are evidence for "config kept in separate modules"; the
# build tool's own config is not. The rule must separate them by FILENAME, since
# both live under a path containing "config".
check("src/config module kept", "src/config/chain.js" in ranked, True)
check("vite.config.js dropped", "vite.config.js" in ranked, False)
check("test file dropped despite being the largest",
      "src/App.test.jsx" in ranked, False)
check("entry files last, not absent",
      ranked[-2:], ["src/App.jsx", "src/main.jsx"])
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

print("\n_plan_for — the repository's size decides how much of it is read")
check("under 20 files is small", pw._plan_for(19)["size"], "small")
check("exactly 20 is still small", pw._plan_for(20)["size"], "small")
check("21 is medium", pw._plan_for(21)["size"], "medium")
check("100 is medium", pw._plan_for(100)["size"], "medium")
check("101 is large", pw._plan_for(101)["size"], "large")
check("an empty repo still gets a plan", pw._plan_for(0)["size"], "small")

SMALL, MEDIUM, LARGE = pw._plan_for(5), pw._plan_for(50), pw._plan_for(400)
# The trade the three plans encode: depth against breadth. A small repository is
# read essentially whole; a large one is read wider and shallower, because in a
# 400-file system the question stops being "is this function well written" and
# becomes "does this contain the pieces the milestone named".
check("small reads files whole", SMALL["per_file"] >= 6000, True)
check("large reads MORE files than medium", LARGE["files"] > MEDIUM["files"], True)
check("large reads them SHALLOWER", LARGE["per_file"] < MEDIUM["per_file"], True)
check("large gets the biggest budget", LARGE["budget"] > MEDIUM["budget"], True)
# files x per_file deliberately exceeds budget in every plan, so the TOTAL binds
# first and a repo of large files fills fewer slots than the ceiling suggests.
for _plan in (SMALL, MEDIUM, LARGE):
    check(f"total binds before the file count ({_plan['size']})",
          _plan["files"] * _plan["per_file"] > _plan["budget"], True)
    check(f"plan fits the hard ceiling ({_plan['size']})",
          _plan["budget"] <= pw.CODE_TEXT_CHARS, True)

# Returned fresh, not a shared module constant: the plan crosses into a nondet
# closure and gets cloudpickled, and a caller mutating it would change the plan
# for every later evaluation in the same process.
_p = pw._plan_for(5)
_p["files"] = 999
check("plan is a fresh dict", pw._plan_for(5)["files"] == 999, False)

print("\n_detect_languages — what the repository is written in")
check("histogram, biggest first",
      pw._detect_languages(["a.py", "b.py", "c.ts"]), [("Python", 2), ("TypeScript", 1)])
# .tsx must be tested before .ts or every React component counts as plain
# TypeScript and a front end detects as a backend.
check("tsx is TypeScript, counted once",
      pw._detect_languages(["a.tsx", "b.ts"]), [("TypeScript", 2)])
check("ties resolve by name, not by dict order",
      pw._detect_languages(["z.go", "a.rs"]), [("Go", 1), ("Rust", 1)])
check("solidity recognised", pw._detect_languages(["Escrow.sol"]), [("Solidity", 1)])
check("notebooks are their own language",
      pw._detect_languages(["train.ipynb"]), [("Jupyter notebook", 1)])
check("unknown extensions counted as nothing", pw._detect_languages(["a.xyz"]), [])

print("\n_detect_frameworks — the toolchain names itself, for free")
check("next.config -> Next.js", pw._detect_frameworks(["next.config.ts"]), ["Next.js"])
check("matched on basename, at any depth",
      pw._detect_frameworks(["packages/web/next.config.js"]), ["Next.js"])
check("hardhat and foundry both reported",
      pw._detect_frameworks(["hardhat.config.ts", "foundry.toml"]),
      ["Hardhat", "Foundry"])
check("reported in signal order, not path order",
      pw._detect_frameworks(["vite.config.js", "next.config.js"]),
      ["Next.js", "Vite"])
check("capped so a monorepo does not list a dozen",
      len(pw._detect_frameworks([
          "next.config.js", "nuxt.config.js", "remix.config.js", "gatsby-config.js",
          "angular.json", "svelte.config.js", "astro.config.mjs", "vite.config.js",
      ])) <= pw.MAX_FRAMEWORKS, True)
check("no config files -> nothing claimed", pw._detect_frameworks(["src/a.ts"]), [])

print("\n_detect_dependencies — the manifest is the highest-signal evidence there is")
PKG_JSON = json.dumps({"dependencies": {
    "next": "16.2.10", "react": "19.0.0", "wagmi": "2.5.0"}})
check("package.json read whatever the format",
      pw._detect_dependencies(PKG_JSON), [("Next.js", "frontend"), ("React", "frontend"),
                                          ("wagmi", "frontend")])
check("requirements.txt pins parsed",
      pw._detect_dependencies("scikit-learn==1.3.0\nnumpy>=1.24\n"),
      [("scikit-learn", "ml"), ("NumPy", "ml")])
check("substring match catches the family",
      pw._detect_dependencies("pytorch-lightning==2.0"), [("PyTorch", "ml")])
check("scoped packages match",
      pw._detect_dependencies('"@openzeppelin/contracts": "5.0.0"'),
      [("OpenZeppelin", "contracts")])
# react-native is tested before react, or every mobile app detects as a web front
# end — and the label dedup keeps sklearn and scikit-learn from both appearing.
check("react-native beats react",
      pw._detect_dependencies('"react-native": "0.73"')[0][0], "React Native")
check("deduplicated by label",
      pw._detect_dependencies("sklearn\nscikit-learn\n"), [("scikit-learn", "ml")])
check("empty manifest -> nothing", pw._detect_dependencies(""), [])

print("\n_project_kind — what KIND of project, so it is reviewed as one")
SOL = [("Solidity", 12), ("TypeScript", 4)]
check("solidity present -> contracts", pw._project_kind(SOL, [], []), "contracts")
# Contracts outrank the front end around them: the contracts hold the money, and
# a reviewer who treats them as an implementation detail reviews the wrong thing.
check("contracts win over a react front end",
      pw._project_kind(SOL, [("React", "frontend")], ["Vite"]), "contracts")
# But a front end that merely TALKS to somebody else's deployed contract pulls in
# ethers and is not a contract project.
check("ethers alone is not a contract project",
      pw._project_kind([("TypeScript", 9)], [("ethers.js", "contracts"),
                                             ("React", "frontend")], []), "frontend")
check("hardhat config rescues a contracts repo with no .sol counted",
      pw._project_kind([], [("Hardhat", "contracts")], ["Hardhat"]), "contracts")
check("torch -> ml", pw._project_kind([("Python", 6)], [("PyTorch", "ml")], []), "ml")
check("notebooks alone -> ml",
      pw._project_kind([("Jupyter notebook", 3), ("Python", 1)], [], []), "ml")
check("react + express -> fullstack",
      pw._project_kind([("TypeScript", 20)],
                       [("React", "frontend"), ("Express", "backend")], []), "fullstack")
check("django alone -> backend",
      pw._project_kind([("Python", 30)], [("Django", "backend")], []), "backend")
check("flutter -> mobile", pw._project_kind([("Dart", 9)], [], ["Flutter"]), "mobile")
check("nothing recognised -> general",
      pw._project_kind([("C", 4)], [], []), "general")
# Every label the classifier can return must have a name and guidance, or the
# prompt silently loses its review criteria for that kind.
for _kind in ("contracts", "ml", "mobile", "fullstack", "frontend", "backend", "general"):
    check(f"{_kind} has a name", _kind in pw.KIND_NAMES, True)

print("\n_named_paths — the client already answered the ranking question")
check("path with an extension",
      pw._named_paths("the escrow logic lives in contracts/Escrow.sol"),
      ["contracts/escrow.sol"])
check("backticks and full stops stripped",
      pw._named_paths("extend `src/hooks/usePayroll.ts`."), ["src/hooks/usepayroll.ts"])
check("a bare directory counts", pw._named_paths("everything under contracts/ ships"),
      ["contracts"])
check("manifest names recognised", pw._named_paths("pin it in package.json"),
      ["package.json"])
check("ordinary prose names nothing", pw._named_paths("build a dashboard that works"), [])
check("sorted and deduplicated",
      pw._named_paths("train.py and train.py and model.py"), ["model.py", "train.py"])

print("\n_wants_tests — tests are a deliverable only when asked for")
check("unit tests requested", pw._wants_tests("must include unit tests"), True)
check("coverage requested", pw._wants_tests("90% code coverage required"), True)
check("named runner requested", pw._wants_tests("write pytest cases for the parser"), True)
check("no mention", pw._wants_tests("build the dashboard and deploy it"), False)

print("\n_find_manifests — where a project states what it is built from")
MANI = ["README.md", "package.json", "requirements.txt", "src/a.ts"]
check("most-informative first", pw._find_manifests(MANI),
      ["package.json", "requirements.txt"])
check("capped", len(pw._find_manifests(MANI)) <= pw.MAX_MANIFESTS, True)
check("subdirectory manifest preferred over the root one",
      pw._find_manifests(["package.json", "Frontend/package.json"], "Frontend"),
      ["Frontend/package.json"])
check("root manifest is the fallback under a subpath",
      pw._find_manifests(["package.json", "contracts/Escrow.sol"], "contracts"),
      ["package.json"])
check("shallowest copy wins",
      pw._find_manifests(["a/b/package.json", "package.json"]), ["package.json"])
check("none present -> []", pw._find_manifests(["src/a.ts"]), [])

print("\n_find_readme — prose is context, and it is scoped like everything else")
check("shallowest wins", pw._find_readme(["docs/README.md", "README.md"]), "README.md")
check("any spelling", pw._find_readme(["docs/readme.rst"]), "docs/readme.rst")
check("subdirectory README preferred",
      pw._find_readme(["README.md", "contracts/README.md"], "contracts"),
      "contracts/README.md")
check("root README is the fallback under a subpath",
      pw._find_readme(["README.md", "contracts/Escrow.sol"], "contracts"), "README.md")
check("no readme -> ''", pw._find_readme(["a.py"]), "")

print("\n_fetch_github_code — inventory first, then context, then implementation")


def _tree(*entries):
    """A GitHub tree response from (path, size) pairs."""
    return json.dumps({"tree": [
        {"type": "blob", "path": p, "size": s} for p, s in entries]}).encode()


def _run_counting(routes, url="https://github.com/acme/widget", focus=""):
    """Run a fetch and report how many api.github.com requests it made.

    The metered surface is the only one that matters: raw is CDN-served and
    unmetered, api.github.com is 60/hr per IP on shared validator egress.

    Returns the evidence dict, or a `RAISED:` string — see `_text`.
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
        return pw._fetch_github_code(url, focus), calls
    except UserError as e:
        return f"RAISED:{e.message}", calls


def _text(result):
    """The evidence text out of whatever `_run_counting` returned."""
    return result if isinstance(result, str) else result["text"]


PY_SRC = b"import sys\n\n\ndef main():\n    print('hi')\n"
TS_SRC = b"export const a = 1\nexport const b = 2\nexport const c = 3\n"

# The ordinary case. The listing is call number one and the only metered call
# there is: every file below it comes from unmetered raw.
ev, calls = _run_counting([
    ("api.github.com", _Resp(200, _tree(
        ("README.md", 100), ("package.json", 200), ("src/index.ts", 300)))),
    ("/HEAD/README.md", _Resp(200, b"# Widget\nDoes a thing.")),
    ("/HEAD/package.json", _Resp(200, PKG_JSON.encode())),
    ("/HEAD/src/index.ts", _Resp(200, TS_SRC)),
])
code = _text(ev)
check("exactly one metered call", calls["api"], 1)
check("README included", "// FILE: README.md" in code, True)
check("manifest included", "// FILE: package.json" in code, True)
check("manifest labelled as one, not as source",
      "package.json (" in code and "dependency manifest" in code, True)
check("source included", "// FILE: src/index.ts" in code, True)
check("real content reaches the prompt", "export const a = 1" in code, True)
check("no Response repr leaks in", "Response(" in code, False)
check("kind detected from the manifest", ev["kind"], "frontend")

# The inventory is what stops an excerpt from reading as a whole repository.
check("inventory counts the files", "3 files" in ev["inventory"], True)
check("inventory names the language", "TypeScript" in ev["inventory"], True)
check("inventory names the dependencies", "React" in ev["inventory"], True)
check("inventory states the classification",
      "front-end web application" in ev["inventory"], True)
check("inventory reports the absence of tests",
      "No test files found" in ev["inventory"], True)
# Carried beside the evidence, never prepended to it: the fingerprint is the
# HEAD of the text, and a paragraph of inventory in front would make every
# repository with the same stack fingerprint alike — handing away the swap check
# that is the validator's whole job.
check("inventory is NOT in the evidence text", "3 files" in code, False)
check("evidence still leads with a file", code.startswith("// FILE:"), True)

# A small repository is read whole, and says so.
check("small repo shows everything", "All 1 source files are shown below" in
      ev["inventory"], True)

# A large one is read wider and shallower, and says THAT.
BIG_TREE = _tree(*([("README.md", 100)] +
                   [(f"src/mod{i:03d}/handler.ts", 900) for i in range(140)]))
ev, calls = _run_counting([
    ("api.github.com", _Resp(200, BIG_TREE)),
    ("/HEAD/README.md", _Resp(200, b"# Platform\nA large system.")),
    ("handler.ts", _Resp(200, TS_SRC)),
])
check("large repo still costs one metered call", calls["api"], 1)
check("large repo reads the large plan's slot count",
      _text(ev).count("// FILE:") - 1, pw.PLAN_LARGE["files"])
check("large repo states it is a sample",
      "of the 140 source files are shown below" in ev["inventory"], True)
check("large repo does not claim completeness",
      "All 140" in ev["inventory"], False)
check("the rest are said to exist", "were not read" in ev["inventory"], True)

print("\n_fetch_github_code — ranking, scoping and the milestone's own words")
# The client named a file. That outranks every inference — including the much
# larger file that size-first ranking would have taken instead.
ev, calls = _run_counting([
    ("api.github.com", _Resp(200, _tree(
        ("contracts/Escrow.sol", 400), ("src/huge.ts", 90000)))),
    ("Escrow.sol", _Resp(200, b"contract Escrow {\n  function lock() {}\n}\n")),
    ("huge.ts", _Resp(200, TS_SRC)),
], focus="the escrow logic lives in contracts/Escrow.sol")
check("a named file is ranked first",
      _text(ev).index("Escrow.sol") < _text(ev).index("huge.ts"), True)

# A /tree/<branch>/<dir> URL scopes the whole evaluation to that directory —
# without it a Solidity milestone was judged on three React pages.
ev, calls = _run_counting([
    ("api.github.com", _Resp(200, _tree(
        ("contracts/Escrow.sol", 400), ("Frontend/src/App.tsx", 9000)))),
    ("Escrow.sol", _Resp(200, b"contract Escrow {}\n// a\n// b\n")),
    ("App.tsx", _Resp(200, TS_SRC)),
], url="https://github.com/acme/mono/tree/main/contracts")
check("subpath scopes the source", "// FILE: contracts/Escrow.sol" in _text(ev), True)
check("out-of-scope files excluded", "App.tsx" in _text(ev), False)
check("scoped repo classified from its own files", ev["kind"], "contracts")

# Tests are excluded by default — they are often the biggest files in a repo and
# would win slots from the code they test.
TEST_TREE = _tree(("src/parser.ts", 400), ("tests/parser.test.ts", 8000))
ROUTES = [("api.github.com", _Resp(200, TEST_TREE)),
          ("src/parser.ts", _Resp(200, TS_SRC)),
          ("tests/parser.test.ts", _Resp(200, b"it('works', () => {})\n// a\n// b\n"))]
ev, _ = _run_counting(ROUTES)
check("tests excluded by default", "parser.test.ts" in _text(ev), False)
check("but counted in the inventory", "1 test files present" in ev["inventory"], True)
# …and fetched when the milestone asks, because judging "must include unit tests"
# from an excerpt that deliberately excluded tests is the same failure as scoring
# code_quality off a repository landing page.
ev, _ = _run_counting(ROUTES, focus="ship the parser with unit tests")
check("tests fetched when the milestone asks for them",
      "// FILE: tests/parser.test.ts" in _text(ev), True)
check("implementation still comes too", "// FILE: src/parser.ts" in _text(ev), True)

print("\n_fetch_github_code — the gm-striker shape, end to end")
VITE_README = (b"# React + Vite\n\nThis template provides a minimal setup to get "
               b"React working in Vite with HMR and some ESLint rules.\n")
GM_TREE = _tree(
    ("README.md", 1027), ("src/App.jsx", 1781), ("src/main.jsx", 1465),
    ("src/components/GMButton.jsx", 4336), ("src/components/StatsCards.jsx", 2547),
    ("vite.config.js", 161))
BIG = b"const x = 1\n" * 800          # ~9600 chars, over the small plan's per-file cap
ev, calls = _run_counting([
    ("api.github.com", _Resp(200, GM_TREE)),
    ("/HEAD/README.md", _Resp(200, VITE_README)),
    ("/HEAD/src/App.jsx", _Resp(200, b"import GMButton from './components/GMButton'\nexport default function App() {}\n// pad\n")),
    ("/HEAD/src/main.jsx", _Resp(200, b"import App from './App'\nrender(App)\n// pad\n")),
    ("/HEAD/src/components/GMButton.jsx", _Resp(200, BIG)),
    ("/HEAD/src/components/StatsCards.jsx", _Resp(200, b"const s = 1\nconst t = 2\nconst u = 3\n")),
], url="https://github.com/kenil1710/gm-striker")
code = _text(ev)

# The whole point of the rewrite: the files holding the requirements are present.
check("component reached", "// FILE: src/components/GMButton.jsx" in code, True)
check("second component reached", "// FILE: src/components/StatsCards.jsx" in code, True)
check("entry files still there for context", "// FILE: src/App.jsx" in code, True)
check("template README excluded", "This template provides" in code, False)
check("its absence is stated", pw.NO_README_NOTE in code, True)
# The note must NOT lead: the fingerprint is the head of the evidence, and a
# fixed 150-char prefix would make every scaffolded repo fingerprint alike.
check("note does not lead the evidence", code.startswith("// FILE:"), True)
check("note survives truncation whole", code.endswith(pw.NO_README_NOTE), True)
check("build config never fetched", "vite.config" in code, False)
check("vite still reported as the toolchain", "Vite" in ev["inventory"], True)

print("\nheaders carry length, role and truncation")
check("role labelled", "UI component" in code, True)
check("entry role labelled", "application entry point" in code, True)
check("real length reported", "(9600 chars" in code, True)
# Five source files is a small repository, so the per-file slice is the small
# plan's — a 9600-char file is cut there, not at some constant.
check("truncated at the PLAN's per-file cap",
      f"showing first {pw.PLAN_SMALL['per_file']}" in code, True)
check("oversized file actually cut",
      code.count("const x = 1") < 800, True)
check("total budget respected", len(code) <= pw.PLAN_SMALL["budget"], True)

print("\n_fetch_github_code — a README is not code (job 16)")
# Django/Rails/Maven/monorepo layouts: a README at the root and no source at any
# conventional path. The old design probed by convention, found the README,
# stopped, and asked the model to score code_quality having been shown nothing
# but prose — job 16 scored 0 there and was rejected at 45 on evidence no
# validator ever saw. Reading the listing first makes the shape unreachable.
ev, calls = _run_counting([
    ("api.github.com", _Resp(200, _tree(
        ("README.md", 100), ("manage.py", 100), ("shop/views.py", 100)))),
    ("/HEAD/README.md", _Resp(200, b"# Shop\nA Django storefront.")),
    ("/HEAD/manage.py", _Resp(200, PY_SRC)),
    ("/HEAD/shop/views.py", _Resp(200, PY_SRC)),
], url="https://github.com/acme/shop")
code = _text(ev)
check("the app's own module is read", "// FILE: shop/views.py" in code, True)
# manage.py is Django's scaffolding, not the deliverable — CONFIG_FILENAMES drops
# it — but its presence still names the framework.
check("scaffolding excluded from the evidence", "// FILE: manage.py" in code, False)
check("scaffolding still names the framework", "Django" in ev["inventory"], True)
check("README not duplicated", code.count("// FILE: README.md"), 1)

# A deep monorepo path with nothing at any conventional location.
ev, _ = _run_counting([
    ("api.github.com", _Resp(200, _tree(("packages/api/src/server.ts", 100)))),
    ("/HEAD/README.md", _Resp(200, b"# Monorepo\nTurbo workspace.")),
    ("/HEAD/packages/api/src/server.ts", _Resp(200, TS_SRC)),
], url="https://github.com/acme/mono")
check("deep paths are reached", "// FILE: packages/api/src/server.ts" in _text(ev), True)

print("\n_fetch_github_code — generated output is not source")
MINIFIED = b"!function(){" + b"z" * 900 + b"}();"
ev, calls = _run_counting([
    ("api.github.com", _Resp(200, _tree(("src/index.js", 900), ("main.py", 100)))),
    ("/HEAD/src/index.js", _Resp(200, MINIFIED)),
    ("/HEAD/main.py", _Resp(200, PY_SRC)),
], url="https://github.com/acme/bundled")
code = _text(ev)
check("bundle excluded from prompt", "// FILE: src/index.js" in code, False)
check("real source used instead", "// FILE: main.py" in code, True)
check("no minified payload leaks in", "z" * 100 in code, False)
check("skipping a bundle still costs one metered call", calls["api"], 1)

print("\n_fetch_github_code — ref handling")
# The default branch is whatever the repo says it is. `main` and `master` were
# guesses; HEAD is the answer, and the listing uses the same ref as every fetch.
ev, _ = _run_counting([
    ("trees/HEAD", _Resp(200, _tree(("main.go", 100)))),
    ("/HEAD/main.go", _Resp(200, b"package main\n\nfunc main() {}\n")),
], url="https://github.com/acme/legacy")
check("listing and fetches share one ref", "// FILE: main.go" in _text(ev), True)

# An explicit /tree/<branch> URL pins that branch instead.
ev, _ = _run_counting([
    ("trees/develop", _Resp(200, _tree(("main.py", 100)))),
    ("/develop/main.py", _Resp(200, PY_SRC)),
], url="https://github.com/acme/widget/tree/develop")
check("pinned branch overrides HEAD", "// FILE: main.py" in _text(ev), True)

print("\n_fetch_github_code — fails closed, and says which kind of failure")
# 403 is GitHub rate-limiting a validator. It MUST raise, not quietly fall back
# to rendering the landing page — that mismatch is what makes an honest
# validator reject an honest leader. And it must NOT be retried: the only thing
# an immediate retry does to a rate limit is deepen it.
ev, calls = _run_counting([("api.github.com", _Resp(403, b"rate limited"))])
check("403 listing raises", _text(ev).startswith("RAISED:[TRANSIENT]"), True)
check("a rate limit is never retried", calls["api"], 1)

# 5xx and a dead connection are blips a retry can actually clear.
ev, calls = _run_counting([("api.github.com", _Resp(503, b"unavailable"))])
check("503 raises transient", _text(ev).startswith("RAISED:[TRANSIENT]"), True)
check("503 is retried", calls["api"], pw.MAX_LISTING_RETRIES + 1)
ev, calls = _run_counting([("api.github.com", _Resp(0, b""))])
check("a dead connection is retried", calls["api"], pw.MAX_LISTING_RETRIES + 1)
check("and still ends transient", _text(ev).startswith("RAISED:[TRANSIENT]"), True)

# 403 partway through, on a file, is the same hazard.
ev, _ = _run_counting([
    ("api.github.com", _Resp(200, _tree(("main.py", 100)))),
    ("main.py", _Resp(403, b"rate limited")),
])
check("403 on a file raises too", _text(ev).startswith("RAISED:[TRANSIENT]"), True)

# 404 is deterministic — every validator sees it, so the messages match exactly
# and _compare_user_errors counts that as agreement.
ev, _ = _run_counting([("api.github.com", _Resp(404, b"Not Found"))],
                      url="https://github.com/acme/private")
check("404 is external, not transient", _text(ev).startswith("RAISED:[EXTERNAL]"), True)
# The advice must not name a branch: HEAD resolves whatever the default is, so
# "check the default branch is main or master" sends the client after a problem
# they do not have.
check("no branch guessing in the advice", "master" in _text(ev), False)

# A pinned branch that does not exist is the one case where naming a branch IS
# the diagnosis, and both sides build the identical message from the URL alone.
ev, _ = _run_counting([("api.github.com", _Resp(404, b"Not Found"))],
                      url="https://github.com/acme/widget/tree/nope")
check("a missing pinned branch is named", "nope" in _text(ev), True)

# Readable listing, nothing showable in it.
ev, _ = _run_counting([("api.github.com", _Resp(200, _tree(("Main.class", 10))))],
                      url="https://github.com/acme/binary")
check("nothing readable raises external", _text(ev).startswith("RAISED:[EXTERNAL]"), True)

# An empty tree is not the same as an unreadable one, and must not be scored.
ev, _ = _run_counting([("api.github.com", _Resp(200, json.dumps({"tree": []}).encode()))],
                      url="https://github.com/acme/empty")
check("an empty repo is rejected clearly", "contains no files" in _text(ev), True)

# Malformed JSON from the API is external, not a crash.
ev, _ = _run_counting([("api.github.com", _Resp(200, b"<html>nope</html>"))])
check("unparseable listing raises external",
      _text(ev).startswith("RAISED:[EXTERNAL]"), True)

# A scaffold README and nothing else readable must still raise. The note is not
# evidence: returning it alone would be a non-empty code_text holding no code.
ev, _ = _run_counting([
    ("api.github.com", _Resp(200, _tree(("README.md", 1027)))),
    ("/HEAD/README.md", _Resp(200, VITE_README)),
], url="https://github.com/acme/scaffold")
check("scaffold README alone raises", _text(ev).startswith("RAISED:[EXTERNAL]"), True)

# A non-GitHub URL must never reach any of this — it returns empty text so the
# caller renders the page instead, and leader and validators all take that same
# branch off the URL alone.
check("non-github short-circuits",
      pw._fetch_github_code("https://gitlab.com/a/b")["text"], "")
check("and claims no inventory",
      pw._fetch_github_code("https://gitlab.com/a/b")["kind"], "")

print("\n_fetch_github_code — insufficient evidence is not a low score")
# Four candidates, one readable. A 25% read must NOT arrive at the model as a
# repository containing one file: a low score REJECTS the milestone and pays
# nothing, permanently, and doing that because GitHub would not serve the files
# punishes the freelancer for a fact about GitHub. Reverting costs a retry.
ev, _ = _run_counting([
    ("api.github.com", _Resp(200, _tree(
        ("src/a.ts", 400), ("src/b.ts", 400), ("src/c.ts", 400), ("src/d.ts", 400)))),
    ("src/a.ts", _Resp(200, TS_SRC)),
], url="https://github.com/acme/half")
check("under half read raises", _text(ev).startswith("RAISED:[EXTERNAL]"), True)
check("and says it is not a judgement",
      "not a judgement on the work" in _text(ev), True)
check("and reports the actual ratio", "1 of 4 source files" in _text(ev), True)

# Exactly half is enough — the threshold is "at least", not "more than".
ev, _ = _run_counting([
    ("api.github.com", _Resp(200, _tree(("src/a.ts", 400), ("src/b.ts", 400)))),
    ("src/a.ts", _Resp(200, TS_SRC)),
], url="https://github.com/acme/exact")
check("exactly half is enough", "// FILE: src/a.ts" in _text(ev), True)

# A README and no readable source is the job-16 shape: `pieces` is non-empty, so
# the old `not pieces` gate let prose through as code_text and the model was
# asked to score code_quality on a paragraph of documentation.
ev, _ = _run_counting([
    ("api.github.com", _Resp(200, _tree(("README.md", 100), ("src/a.ts", 400)))),
    ("/HEAD/README.md", _Resp(200, b"# Shop\nA storefront.")),
], url="https://github.com/acme/prose")
check("a README alone is never scored as code",
      _text(ev).startswith("RAISED:[EXTERNAL]"), True)
check("and says no SOURCE was read", "No source code could be read" in _text(ev), True)

# THE FALSE POSITIVE THIS MUST NOT HAVE. Big files exhaust the budget long
# before the slot count, so `read` is far below the plan's `files` — and that is
# the budget working exactly as designed, on the repositories that gave us the
# most to read. Measured against files ATTEMPTED, it is 100%.
HUGE = b"const x = 1;\n" * 3000                      # ~39000 chars, over any plan
ev, _ = _run_counting([
    ("api.github.com", _Resp(200, _tree(*[(f"src/big{i}.ts", 39000) for i in range(9)]))),
    ("src/big", _Resp(200, HUGE)),
], url="https://github.com/acme/chunky")
check("budget exhaustion is not insufficiency",
      _text(ev).startswith("RAISED:"), False)
check("the files that fit were read", "// FILE: src/big0.ts" in _text(ev), True)
check("fewer slots filled than the plan allows",
      ev["read"] < pw._plan_for(9)["files"], True)
check("but every attempt succeeded", ev["read"], ev["attempted"])

print("\n_kind_guidance — a Solidity contract is not well-written like a React screen")
for _kind in ("contracts", "ml", "mobile", "fullstack", "frontend", "backend", "general"):
    # A missing entry would silently drop the type-aware half of the prompt
    # rather than failing, so every label the classifier can return is asserted.
    check(f"{_kind} has guidance", len(pw._kind_guidance(_kind)) > 40, True)
check("an unknown kind falls back rather than emptying",
      pw._kind_guidance("wat"), pw.KIND_GUIDANCE["general"])
check("contracts guidance is about custody",
      "reentrancy" in pw._kind_guidance("contracts"), True)
check("frontend guidance is about the interface",
      "accessibility" in pw._kind_guidance("frontend"), True)
check("ml guidance is about the pipeline, not the accuracy number",
      "leak" in pw._kind_guidance("ml"), True)
check("the kinds actually differ",
      pw._kind_guidance("contracts") == pw._kind_guidance("frontend"), False)

print("\n_evidence_prompt — universal rubric, type-aware lens")
W = {"code": 35, "design": 0, "functionality": 35, "completeness": 30}
INV = "142 files, 78 of them source (61 TypeScript, 12 Solidity). Reviewed as: a smart-contract project."
prompt = pw._evidence_prompt("// FILE: a.sol\n   1| contract X {}", "", "Ship the escrow",
                             "Build an escrow", W, False, INV, "contracts")
check("inventory reaches the prompt", INV in prompt, True)
check("inventory is labelled", "WHAT THIS REPOSITORY IS" in prompt, True)
check("kind named in words a reviewer uses",
      "a smart-contract project" in prompt, True)
check("kind-specific criteria included",
      "reentrancy" in prompt, True)
check("the universal calibration survives", "90-100" in prompt, True)
check("citations still demanded", "path/to/file.ext:LINE" in prompt, True)
check("JSON contract still last", prompt.rstrip().endswith("}"), True)

# The same evidence, classified differently, must produce a different review.
other = pw._evidence_prompt("// FILE: a.tsx\n   1| export const A = () => null",
                            "", "Ship the dashboard", "Build a dashboard", W, False,
                            INV, "frontend")
check("a different kind asks for different things",
      "reentrancy" in other, False)
check("and supplies its own", "accessibility" in other, True)

# The non-GitHub render path has no listing to derive either from, and must
# still produce a valid prompt rather than headers with nothing under them.
bare = pw._evidence_prompt("rendered page text", "", "Ship it", "Build it", W, False)
check("no inventory section when there is no inventory",
      "WHAT THIS REPOSITORY IS" in bare, False)
check("no criteria section when the kind is unknown",
      "HOW TO REVIEW THIS KIND" in bare, False)
check("the rubric is still there", "90-100" in bare, True)

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
ev = {"code_fp": "abc page one", "site_fp": "xyz page two", "code_len": 1000,
      "site_len": 500, "inv_fp": "12 files, 9 of them source", "kind": "contracts"}
honest = dict(good); honest.update({
    "code_fp": "abc page one", "site_fp": "xyz page two", "code_len": 1000,
    "site_len": 500, "inv_fp": "12 files, 9 of them source", "kind": "contracts"})
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

# The inventory steers the review — how much of the repo the excerpt is, and
# which criteria the prompt carries — so a leader that reported a different one
# scored against different instructions, whatever the source text says.
lied_inventory = dict(honest); lied_inventory["inv_fp"] = "400 files, 380 of them source"
check("leader misreported the inventory, REJECTED",
      pw._evidence_matches(lied_inventory, ev), False)

lied_kind = dict(honest); lied_kind["kind"] = "frontend"
check("leader misreported the project kind, REJECTED",
      pw._evidence_matches(lied_kind, ev), False)

print("\n_compare_user_errors")
E = UserError
check("LLM never agrees", pw._compare_user_errors(E("[LLM_ERROR] x"), E("[LLM_ERROR] x")), False)
check("both transient agree", pw._compare_user_errors(E("[TRANSIENT] a"), E("[TRANSIENT] b")), True)
check("same expected agrees", pw._compare_user_errors(E("[EXPECTED] q"), E("[EXPECTED] q")), True)
check("different expected disagrees", pw._compare_user_errors(E("[EXPECTED] q"), E("[EXPECTED] z")), False)
check("external mismatch disagrees", pw._compare_user_errors(E("[EXTERNAL] 404"), E("[EXTERNAL] 500")), False)

print("\n" + ("FAILED: " + "; ".join(fails) if fails else "all passed"))
sys.exit(1 if fails else 0)
