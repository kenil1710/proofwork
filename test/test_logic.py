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


print("\n_extract_scores — shapes a model actually returns")
clean = '{"code_quality": 85, "design_match": 90, "functionality": 80, "completeness": 88}'
check("clean json", pw._extract_scores(clean),
      {"code": 85, "design": 90, "functionality": 80, "completeness": 88})
check("fenced json", pw._extract_scores("```json\n" + clean + "\n```"),
      {"code": 85, "design": 90, "functionality": 80, "completeness": 88})
check("chatty prose", pw._extract_scores("Here you go:\n" + clean + "\nHope that helps!"),
      {"code": 85, "design": 90, "functionality": 80, "completeness": 88})
check("dict passthrough", pw._extract_scores(json.loads(clean)),
      {"code": 85, "design": 90, "functionality": 80, "completeness": 88})
check("float + string values",
      pw._extract_scores('{"code_quality": 84.6, "design_match": "90", "functionality": " 80 ", "completeness": 88}'),
      {"code": 85, "design": 90, "functionality": 80, "completeness": 88})
check("missing axis -> 0",
      pw._extract_scores('{"code_quality": 85}'),
      {"code": 85, "design": 0, "functionality": 0, "completeness": 0})
check("out of range clamps",
      pw._extract_scores('{"code_quality": 130, "design_match": -5, "functionality": 80, "completeness": 88}'),
      {"code": 100, "design": 0, "functionality": 80, "completeness": 88})

for bad in ("I cannot evaluate this.", "", "score is high"):
    try:
        pw._extract_scores(bad)
        fails.append(f"no-json {bad!r} should have raised")
        print(f"  FAIL no-json {bad!r} did not raise")
    except UserError as e:
        assert e.message.startswith("[LLM_ERROR]"), e.message
        print(f"  ok   no-json {bad!r} -> LLM_ERROR")

try:
    pw._extract_scores('{"code_quality": "excellent"}')
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
