"""
Show exactly what the AI reviewer is handed for a submission.

Runs the real `_fetch_github_code` / `_gather_evidence` / `_evidence_prompt` out
of `contracts/proof_work.py` outside GenVM, with `gl.nondet.web.get` wired to
real HTTP, and prints the literal prompt string that `gl.nondet.exec_prompt`
would receive. No chain, no LLM, no transaction — nothing is verified or paid.

    python3 test/evidence-probe.py --github https://github.com/owner/repo \
                                   --site https://example.com
    python3 test/evidence-probe.py --input submission.json

`--input` takes {"github_url","site_url","mockup_url","requirements",
"milestone_desc"} — the five fields `verify_milestone` passes into the nondet
block — so the prompt can be reproduced byte-for-byte from a real milestone.

FIDELITY — read before drawing conclusions:

* The GitHub half is faithful. `_web_get` only needs `status` and a `body` of
  bytes, and `urllib` supplies both with the contract's own headers, so every
  probe, budget and skip rule below is the real code path on real responses.
* The site half is NOT. GenVM's `web.render(mode="text")` drives a real browser
  and executes JavaScript; this stub performs one GET and strips tags. For a
  client-rendered SPA the stub sees an empty shell where GenVM would see the
  hydrated page, so treat `site_text` here as a floor, not as what a validator
  saw. The report flags SPA shells explicitly.
* Screenshots are not taken at all — they never reach the text prompt.
"""
import argparse, importlib.util, json, pathlib, re, sys, types, urllib.error, urllib.request

# ── stub the genlayer module ────────────────────────────────────────────────
# Same shape as test/test_logic.py, plus a live `gl.nondet.web`.
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


REQUESTS = []
"""Every HTTP call the contract made, in order — the probe sequence is half the
diagnosis, so it is recorded rather than just counted."""


class _Response:
    """What `gl.nondet.web.get` hands back: `status` plus a body of BYTES."""

    def __init__(self, status, body):
        self.status = status
        self.body = body
        self.headers = {}


def _http_get(url, headers=None):
    request = urllib.request.Request(url, headers=dict(headers or {}))
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            body = response.read()
            status = int(response.status)
            final = response.geturl()
    except urllib.error.HTTPError as error:
        body = error.read() or b""
        status = int(error.code)
        final = url
    except Exception as error:  # DNS, TLS, timeout — the contract's status 0
        REQUESTS.append({"url": url, "status": 0, "bytes": 0, "note": repr(error)})
        raise
    REQUESTS.append({
        "url": url,
        "status": status,
        "bytes": len(body),
        "note": f"redirected to {final}" if final != url else "",
    })
    return _Response(status, body)


TAGS = re.compile(r"<(script|style)\b.*?</\1>", re.S | re.I)
ANY_TAG = re.compile(r"<[^>]+>")


def _render(url, mode="text"):
    """Crude stand-in for GenVM's browser renderer. See FIDELITY above."""
    if mode == "screenshot":
        return b""
    try:
        response = _http_get(url, {"User-Agent": "ProofWork-EvidenceProbe"})
    except Exception:
        return ""
    html = response.body.decode("utf-8", "replace")
    RENDERED_HTML[url] = html
    text = ANY_TAG.sub(" ", TAGS.sub(" ", html))
    return " ".join(text.split())


RENDERED_HTML = {}


class _GL:
    vm = _VM()
    nondet = types.SimpleNamespace(
        web=types.SimpleNamespace(get=_http_get, render=_render),
        exec_prompt=lambda *a, **k: (_ for _ in ()).throw(
            AssertionError("evidence-probe must never call an LLM")
        ),
    )
    storage = types.SimpleNamespace()
    evm = types.SimpleNamespace(contract_interface=lambda c: c)
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


def rule(title):
    print(f"\n{'─' * 78}\n{title}\n{'─' * 78}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", help="JSON file with the five submission fields")
    parser.add_argument("--github", default="")
    parser.add_argument("--site", default="")
    parser.add_argument("--mockup", default="none")
    parser.add_argument("--requirements", default="(not supplied)")
    parser.add_argument("--milestone-desc", default="(not supplied)")
    args = parser.parse_args()

    fields = {
        "github_url": args.github,
        "site_url": args.site,
        "mockup_url": args.mockup,
        "requirements": args.requirements,
        "milestone_desc": args.milestone_desc,
    }
    if args.input:
        fields.update(json.loads(pathlib.Path(args.input).read_text()))

    github_url = str(fields["github_url"])
    site_url = str(fields["site_url"])
    mockup_url = str(fields["mockup_url"])

    # ── the deterministic classification verify_milestone does first ──
    has_code = pw._is_usable_url(github_url)
    has_site = pw._is_usable_url(site_url)
    has_mockup = pw._is_usable_url(mockup_url)

    if has_code and has_site and has_mockup:
        weights = {"code": 25, "design": 25, "functionality": 25, "completeness": 25}
    elif has_code and has_site:
        weights = {"code": 35, "design": 0, "functionality": 35, "completeness": 30}
    elif has_code:
        weights = {"code": 50, "design": 0, "functionality": 0, "completeness": 50}
    elif has_mockup:
        weights = {"code": 0, "design": 30, "functionality": 40, "completeness": 30}
    else:
        weights = {"code": 0, "design": 0, "functionality": 50, "completeness": 50}

    rule("SUBMISSION")
    print(f"  github  {github_url!r}  usable={has_code}")
    print(f"  site    {site_url!r}  usable={has_site}")
    print(f"  mockup  {mockup_url!r}  usable={has_mockup}")
    print(f"  weights {weights}")
    print(f"  repo    {pw._parse_github_repo(github_url) or '(not a GitHub URL)'}")

    # ── the code half, on its own, so its failure mode is unambiguous ──
    #
    # `focus` is what steers file ranking, and it is derived here exactly as
    # the contract derives it — a probe that passed nothing would exercise the
    # untargeted fallback and quietly report better evidence than a real
    # verification gets.
    focus = pw._evidence_focus(str(fields["milestone_desc"]), str(fields["requirements"]))
    print(f"  focus   {focus[:70]!r}{'…' if len(focus) > 70 else ''}")
    print(f"  ranks   ext={pw._preferred_extensions(focus) or '(no language named)'}"
          f"  tokens={pw._milestone_tokens(focus)[:10]}")

    rule("_fetch_github_code")
    code_text = ""
    fetched = {}
    if has_code and pw._parse_github_repo(github_url):
        try:
            fetched = pw._fetch_github_code(github_url, focus)
            code_text = str(fetched["text"])
        except UserError as error:
            print(f"  RAISED  {error.message}")
        except Exception as error:
            print(f"  CRASHED {error!r}")

    for entry in REQUESTS:
        note = f"  {entry['note']}" if entry["note"] else ""
        print(f"  {entry['status']:>3}  {entry['bytes']:>7}B  {entry['url']}{note}")

    files = re.findall(r"^// FILE: (.+)$", code_text, re.M)
    if fetched:
        # The size plan is chosen from the repository, so report the plan that
        # was actually used rather than the constants — "12 of 78 read" is the
        # number that explains a completeness score.
        print(f"\n  kind    {fetched['kind']}")
        print(f"  slots   {fetched['read']} filled of {fetched['planned']} planned")
        print(f"  invent  {fetched['inventory']}")
    print(f"\n  chars   {len(code_text)} of budget {pw.CODE_TEXT_CHARS}")
    print(f"  files   {files if files else '(none)'}")
    if code_text:
        print("\n  ── code_text as the prompt receives it ──")
        for line in code_text.splitlines():
            print(f"  │ {line}")
        print("  └── end of code_text")

    # ── the full evidence dict, then the literal prompt ──
    rule("_gather_evidence")
    try:
        evidence = pw._gather_evidence(github_url if has_code else "",
                                       site_url if has_site else "", focus)
    except UserError as error:
        print(f"  RAISED  {error.message}")
        return 1

    site_text = str(evidence["site_text"])
    print(f"  code_len {evidence['code_len']}   code_fp {evidence['code_fp']!r}")
    print(f"  site_len {evidence['site_len']}   site_fp {evidence['site_fp']!r}")

    html = RENDERED_HTML.get(site_url, "")
    if html and len(site_text) < 200:
        roots = re.findall(r'<div[^>]+id="(root|app|__next)"[^>]*>\s*</div>', html, re.I)
        print(f"\n  ⚠ site_text is {len(site_text)} chars from a {len(html)}-byte page."
              f"{' Empty SPA mount point found: ' + str(roots) + '.' if roots else ''}")
        print("    GenVM executes JS and would see more. This stub does not — see FIDELITY.")

    rule("THE PROMPT (exactly what exec_prompt receives)")
    prompt = pw._evidence_prompt(
        str(evidence["code_text"]),
        site_text,
        str(fields["milestone_desc"]),
        str(fields["requirements"]),
        weights,
        bool(has_site and has_mockup and int(weights["design"]) > 0),
    )
    print(prompt)
    rule(f"END OF PROMPT — {len(prompt)} chars")
    return 0


if __name__ == "__main__":
    sys.exit(main())
