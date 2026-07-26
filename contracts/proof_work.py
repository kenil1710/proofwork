# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
from genlayer import *
from dataclasses import dataclass
import json


@allow_storage
@dataclass
class Milestone:
    description: str
    percentage: u32
    status: str
    github_url: str
    site_url: str
    mockup_url: str
    code_score: u32
    design_score: u32
    functionality_score: u32
    completeness_score: u32
    final_score: u32


@allow_storage
@dataclass
class Job:
    client: Address
    freelancer: Address
    title: str
    requirements: str
    total_amount: u64
    status: str
    milestone_count: u32
    completed_milestones: u32
    # ── Anti-scam fields ──────────────────────────────────────────────────
    # Appended at the end on purpose: storage layout is positional, so
    # inserting above would shift every field after it.
    #
    # u64 throughout, never u256 — a u256 storage field makes the contract
    # undeployable (`invalid_contract`). Values are cast to u256 only at the
    # `emit_transfer` call site.
    deadline: u64
    """Epoch seconds by which every milestone must be verified."""
    required_stake: u64
    """What a freelancer must deposit to accept. May be 0."""
    freelancer_stake: u64
    """What was actually deposited. 0 until accepted, 0 again once returned."""
    accepted_at: u64
    """Epoch seconds when the job was accepted; 0 while open."""
    paid_out: u64
    """Cumulative milestone payments already sent to the freelancer. Needed so
    an abandonment refunds only what is genuinely left in escrow."""


MAX_STAKE_PCT = 50
"""Ceiling on the stake a client may demand, as a percentage of escrow.

Not arbitrary. The stake exists to make abandoning a job cost something; past
roughly half the escrow it stops being a deterrent and becomes a way for a
client to extract more from a freelancer than the job is worth, which is the
scam running the other direction."""


# ── Clock ────────────────────────────────────────────────────────────────────
# GenVM has no `block.timestamp`. `gl.message` carries only contract/sender/
# origin address, value and chain_id. The one time-like field is
# `gl.message_raw['datetime']`, an ISO-8601 UTC string ("2026-07-21T17:24:46Z")
# fixed in the transaction message — so every validator executing a given
# transaction reads the identical value, which is what makes it safe to branch
# on inside a deterministic method. Verified on Bradbury before this was built:
# present in both view and write paths, and a write branching on it reached
# consensus and committed.
#
# It is the transaction's time, not the block's, so it can trail wall clock by
# a few seconds. Deadlines here are days, so that is immaterial — but do not
# reuse this for anything needing sub-minute precision.


def _days_from_civil(y: int, m: int, d: int) -> int:
    """Days since 1970-01-01 for a proleptic Gregorian date.

    Howard Hinnant's civil_from_days inverse, integer-only. Written out rather
    than using `datetime` so the arithmetic is unambiguously deterministic and
    carries no import that the linter or a future runner might reject.
    """
    y2 = y - 1 if m <= 2 else y
    era = (y2 if y2 >= 0 else y2 - 399) // 400
    yoe = y2 - era * 400
    mp = m - 3 if m > 2 else m + 9
    doy = (153 * mp + 2) // 5 + d - 1
    doe = yoe * 365 + yoe // 4 - yoe // 100 + doy
    return era * 146097 + doe - 719468


def _epoch_now() -> int:
    """Current time in epoch seconds, from the transaction's datetime.

    Returns 0 when the field is missing or malformed. Callers must treat 0 as
    "clock unavailable" and refuse to make a time-based decision rather than
    treating it as 1970 — otherwise an unreadable clock would silently make
    every deadline appear to have passed.
    """
    raw = str(gl.message_raw.get("datetime", ""))
    # Expected: YYYY-MM-DDTHH:MM:SSZ  (a trailing offset is not produced by the
    # runtime, so anything that does not match this shape is treated as absent)
    if len(raw) < 19 or raw[4] != "-" or raw[7] != "-" or raw[10] != "T":
        return 0
    try:
        year = int(raw[0:4])
        month = int(raw[5:7])
        day = int(raw[8:10])
        hour = int(raw[11:13])
        minute = int(raw[14:16])
        second = int(raw[17:19])
    except ValueError:
        return 0
    if month < 1 or month > 12 or day < 1 or day > 31:
        return 0
    if hour > 23 or minute > 59 or second > 60:
        return 0
    return _days_from_civil(year, month, day) * 86400 + hour * 3600 + minute * 60 + second


@gl.evm.contract_interface
class _Payee:
    """
    Recipient handle for paying native GEN out to a wallet.

    Clients and freelancers are EOAs, and paying an EOA is an *external*
    message routed through this contract's ghost contract — so it needs an EVM
    contract interface even though no contract is deployed at the address.
    The alternatives both fail: `gl.get_contract_at` is for IC-to-IC internal
    messages, and `gl.ContractAt` is the v0.1.0 spelling that no longer exists,
    which raises a VmError and rolls the whole call back. Pattern copied from
    genlayer-studio `examples/contracts/faucet.py`, which pins this same runner.

    Note these transfers apply on FINALIZATION, not on acceptance, so a
    refunded or paid balance is not visible the moment the call is accepted.
    """

    class View:
        pass

    class Write:
        pass


# ─────────────────────────────────────────────────────────────────────────────
# AI evaluators — module-level ON PURPOSE, not methods.
#
# These run inside the `gl.vm.run_nondet` block in `verify_milestone`. A lambda
# that calls `self._gather_and_score(...)` captures `self`, and `self` is a
# storage-backed contract instance — GenVM then tries to pickle it to set up the
# non-deterministic block and dies with an unrecoverable `VmError`:
#
#     Detected pickling storage class. Reading storage in nondet mode
#     is not supported          (genlayer/gl/_internal/storage.py:21)
#
# It fails at run_time 0s with empty eq_outputs, i.e. before any web render or
# LLM call happens, so it looks nothing like a scoring problem. Keeping these as
# free functions means the closures capture only plain `str` values that
# `verify_milestone` already copied out of storage.
#
# Do not turn these back into methods.
# ─────────────────────────────────────────────────────────────────────────────


# Error classes. The prefix tells a validator how to treat a failure the leader
# also hit — see `_compare_user_errors`. Without this, two validators failing
# for unrelated reasons look like agreement.
ERROR_EXPECTED = "[EXPECTED]"  # business rule — deterministic, must match exactly
ERROR_EXTERNAL = "[EXTERNAL]"  # evidence unreachable / 4xx — deterministic
ERROR_TRANSIENT = "[TRANSIENT]"  # network blip — agreement if both hit one
ERROR_LLM = "[LLM_ERROR]"  # model misbehaved — never agreement, force rotation

# The four scoring axes, in the order they are weighted and stored.
SCORE_KEYS = ("code", "design", "functionality", "completeness")

# What the model is asked to call each axis, mapped to our internal key.
SCORE_ALIASES = {
    "code": ("code_quality", "code", "codeQuality", "quality"),
    "design": ("design_match", "design", "designMatch", "visual"),
    "functionality": ("functionality", "function", "functional", "features"),
    "completeness": ("completeness", "complete", "coverage"),
}

# A milestone pays out at 70+. That gate is the one thing validators must agree
# on exactly — it decides whether money moves at all.
PASS_THRESHOLD = 70

# ── Evidence-integrity validation ──
#
# Validators verify the EVIDENCE, not the judgement. Measured on Bradbury
# 2026-07-20 with three contracts differing only in validator cost
# (test/probe_consensus.py):
#
#   leader renders a page, validator does an isinstance check  -> ACCEPTED,  12s
#   leader renders + 1 LLM prompt, validator isinstance check  -> ACCEPTED, 400s
#   leader renders + 1 LLM prompt, validator reruns the same   -> never commits
#
# A single LLM call on each validator means the transaction never commits — it
# dies in APPEAL_COMMITTING having revealed no votes. That rules out rerunning
# the evaluation AND rules out `prompt_non_comparative`, whose validators also
# each run a prompt. (That is the real reason the original four-block design
# went UNDETERMINED; it was never about disagreeing over a subjective number.)
#
# So the validator re-fetches the pages — cheap and proven — and confirms the
# leader scored the same evidence it can see. It cannot catch a leader that
# judged real evidence badly, but it does catch one that invented evidence,
# swapped the URL, or scored a page it never fetched.
EVIDENCE_FINGERPRINT_CHARS = 160
EVIDENCE_LEN_TOLERANCE_PCT = 10
EVIDENCE_LEN_FLOOR = 64


def _clamp_score(value: int) -> int:
    if value < 0:
        return 0
    if value > 100:
        return 100
    return value


def _coerce_score(raw: object) -> int:
    """int, float, "85", " 85.0 " — models return all of these."""
    return _clamp_score(int(round(float(str(raw).strip()))))


def _find_json(text: str) -> object:
    """Pull the first JSON object out of a reply that may be fenced or chatty."""
    cleaned = text.replace("```json", "").replace("```", "").strip()
    start = cleaned.find("{")
    end = cleaned.rfind("}")
    if start == -1 or end <= start:
        return None
    try:
        candidate = json.loads(cleaned[start : end + 1])
    except Exception:
        return None
    return candidate if isinstance(candidate, dict) else None


def _extract_scores(reply: object, weights: dict) -> dict:
    """
    Pull all four scores out of whatever the model actually returned.

    Raises `gl.vm.UserError` with the `[LLM_ERROR]` prefix rather than
    defaulting to zero: a zero is a permanent rejection of someone's work, and
    "the model was chatty" is not a reason to refuse to pay. The prefix makes
    validators disagree, which rotates onto a model that will answer properly.

    `weights` decides how a *missing* axis is treated, which is why it has to be
    passed in rather than inferred. See the branch below.
    """
    if isinstance(reply, dict):
        parsed: object = reply
    else:
        parsed = _find_json(str(reply))

    if not isinstance(parsed, dict):
        raise gl.vm.UserError(
            f"{ERROR_LLM} Could not read a JSON score object from the model's reply"
        )

    scores = {}
    for key in SCORE_KEYS:
        raw = None
        for alias in SCORE_ALIASES[key]:
            if alias in parsed:
                raw = parsed[alias]
                break
        if raw is None:
            weight = int(weights.get(key, 0))

            # An axis the model left out scores zero ONLY when it carries no
            # weight — there, zero is multiplied by zero and cannot move the
            # result.
            #
            # When the axis DOES carry weight, zero is not a safe default: it
            # is the freelancer paying for the model's omission. On a
            # full-evidence job a reply of 95/95/95 with design_match missing
            # rolls up to 71, which pays the 70% band instead of 100% — a
            # quarter of the milestone lost to a formatting slip, and nothing
            # in the receipt would say why.
            #
            # So raise with the LLM prefix instead. `_compare_user_errors`
            # never counts an [LLM_ERROR] as agreement, so validators disagree
            # and the set rotates onto a model that answers properly. Retrying
            # is cheap; a wrong payout is permanent.
            if weight > 0:
                raise gl.vm.UserError(
                    f"{ERROR_LLM} Model omitted {key}, which carries "
                    f"{weight}% of this milestone's score"
                )
            scores[key] = 0
            continue
        try:
            scores[key] = _coerce_score(raw)
        except Exception:
            raise gl.vm.UserError(f"{ERROR_LLM} Non-numeric score for {key}: {raw}")

    return scores


def _weighted_final(scores: dict, weights: dict) -> int:
    """Deterministic weighted roll-up. Weights are plain ints summing to 100."""
    total = 0
    for key in SCORE_KEYS:
        total += int(scores.get(key, 0)) * int(weights.get(key, 0))
    return total // 100


def _evidence_prompt(
    code_text: str,
    site_text: str,
    milestone_desc: str,
    requirements: str,
    weights: dict,
    has_shots: bool,
) -> str:
    """
    One prompt covering all four criteria.

    Previously this was four separate prompts in four separate consensus
    blocks. Asking for all four scores at once is not just cheaper — it also
    lets the model see the whole deliverable before scoring any one axis,
    which is how a human reviewer would do it.
    """
    if code_text:
        code_section = f"REPOSITORY CONTENT:\n{code_text}"
    else:
        code_section = "REPOSITORY: not submitted for this milestone."

    if site_text:
        site_section = f"DEPLOYED SITE TEXT:\n{site_text}"
    else:
        site_section = "DEPLOYED SITE: not submitted for this milestone."

    if has_shots:
        image_section = (
            "You are also given two images: Image 1 is a screenshot of the "
            "deployed site (what was built), Image 2 is the original mockup "
            "(what was expected). Use them for design_match."
        )
    else:
        image_section = (
            "No screenshots are available, so design_match is not applicable."
        )

    # Only the axes carrying weight actually affect payment; telling the model
    # which those are keeps it from agonising over scores that get multiplied
    # by zero.
    applicable = [k for k in SCORE_KEYS if int(weights.get(k, 0)) > 0]

    return f"""You are reviewing a freelance deliverable against its milestone.

PROJECT REQUIREMENTS:
{requirements}

THIS MILESTONE:
{milestone_desc}

{code_section}

{site_section}

{image_section}

Score each of these 0-100. Scores that count for this submission: {", ".join(applicable)}.
Give 0 for any axis with no evidence to judge it on.

- code_quality: does the code address the requirements, is it structured and
  readable, is it free of obvious bugs?
- design_match: how closely does the deployed site match the mockup in layout,
  colour and typography?
- functionality: does the site load, are the required features present and
  apparently working?
- completeness: what fraction of the milestone description is actually
  delivered, versus stubbed or missing?

Calibration — use the full range honestly:
- 90-100: meets the milestone in full, production quality.
- 80-89: meets the milestone with minor gaps or rough edges.
- 70-79: substantially delivered but with real gaps.
- below 70: key parts of the milestone are missing or broken.

Respond ONLY with a JSON object, no prose, no code fences:
{{"code_quality": <int>, "design_match": <int>, "functionality": <int>, "completeness": <int>}}
"""


def _is_usable_url(url: str) -> bool:
    """Whether a submitted string is something a fetcher can actually open.

    The old test was `url != "" and url != "none"`, which only ever caught the
    one sentinel the UI happens to send. Anything else a freelancer typed into
    the box — "nope", "n/a", "-", "TBD", a bare space — read as evidence
    supplied. For a mockup that is not a harmless mistake: `has_mockup` flips
    the weights to 25/25/25/25 and then the leader calls
    `web.render(mode="screenshot")` on a string that is not a URL. Observed
    live, a submission with `mockup_url="nope"` settled UNDETERMINED, so the
    milestone could not be scored at all.

    So the rule is positive rather than a blocklist: a scheme this contract can
    fetch, and a host that could resolve. Everything else is absent, and the
    weights fall through to the branch that does not depend on it.

    The dot requirement rejects `http://nope`, which is well-formed but not
    reachable from a validator. It also rejects `http://localhost/...`, which
    is deliberate — a page only the freelancer can see is not evidence.
    """
    text = str(url).strip()
    lowered = text.lower()

    if lowered.startswith("https://"):
        rest = text[len("https://"):]
    elif lowered.startswith("http://"):
        rest = text[len("http://"):]
    else:
        return False

    # The authority is everything before the first path, query or fragment.
    host = rest
    for sep in ("/", "?", "#"):
        cut = host.find(sep)
        if cut != -1:
            host = host[:cut]

    # Drop userinfo and port — neither is part of the host name.
    at = host.rfind("@")
    if at != -1:
        host = host[at + 1:]
    colon = host.rfind(":")
    if colon != -1:
        host = host[:colon]

    host = host.strip()
    if not host:
        return False

    # A reachable host is dotted: `example.com`, `1.2.3.4`. A single bare label
    # is either an intranet name or somebody's typo.
    if "." not in host:
        return False
    # No empty labels — catches "http://.com", "http://example..com" and a
    # trailing dot typo.
    for label in host.split("."):
        if not label:
            return False
    return True


def _normalize(text: str) -> str:
    """Collapse whitespace so trivial formatting drift between two fetches of
    the same page does not read as a different page."""
    return " ".join(str(text).split())


def _fingerprint(text: str) -> str:
    """A short, stable signature of a rendered page.

    Deliberately the *head* of the normalized text rather than a hash of all of
    it: a hash would differ on any trailing timestamp, view counter or ad slot,
    and every validator would disagree. The opening ~160 characters of a page
    are stable across fetches while still being specific enough that a
    different page cannot match by accident.
    """
    return _normalize(text)[:EVIDENCE_FINGERPRINT_CHARS]


# ── GitHub source retrieval ──────────────────────────────────────────────────
#
# `web.render(repo_url, mode="text")` returns the repository LANDING PAGE — nav
# chrome, the file listing, the star count, part of the README. Not one line of
# source ever reached the prompt, so `code_quality` was unscoreable on every
# code job on the platform.
#
# Confirmed live on Studionet job 16: a real submission scored functionality 72
# and completeness 68, but code_quality 0, and was rejected at 45 — on evidence
# the model was never shown. The freelancer was refused payment for code no
# validator had read.
#
# So fetch actual file content through the API instead. Every step below is
# deterministic given the same repository state, which is load-bearing: the
# validators run this too and compare fingerprints, so a selection that varied
# by dict ordering or wall clock would make honest validators disagree with an
# honest leader.

GITHUB_DEFAULT_REF = "HEAD"
"""The ref used whenever the submitted URL does not pin one.

Both `raw.githubusercontent.com/<owner>/<repo>/HEAD/<path>` and
`/git/trees/HEAD` resolve to whatever the repository's default branch actually
is. Verified live against a repository whose default is neither of the names
this code used to guess: `Perl/perl5` (default `blead`) serves `/HEAD/README`
and 404s on `/main/README`.

This replaces guessing `main` then `master`, which cost two things. It spent a
probe per candidate before any source could be fetched, and — worse — it needed
some file known to exist on every candidate in order to tell which name was
live. That file was hardcoded `README.md`, so a repository with `README.rst`, a
lowercase `readme.markdown`, or no README at all was judged to have no
identifiable branch and fell through to the metered listing API, which returns
403 from the shared egress addresses validators actually run on.

One symbolic ref removes the guess, the extra probe, and that whole class of
false negative — and covers `develop`, `trunk` and any renamed default that a
two-name guess never could.

Deterministic across validators: GitHub resolves the ref server-side from the
same repository state every side reads, so the leader and the validators fetch
byte-identical content and their fingerprints match."""

SOURCE_EXTENSIONS = (
    # Scripting, server-side, data
    ".py", ".rb", ".php", ".sh", ".sql",
    # JS/TS and single-file component formats
    ".ts", ".tsx", ".js", ".jsx", ".vue", ".svelte",
    # Markup and styles — a front-end milestone may be almost entirely these
    ".html", ".css",
    # Compiled and systems languages
    ".java", ".cs", ".c", ".h", ".cpp", ".hpp", ".go", ".rs",
    ".swift", ".kt", ".scala", ".dart",
    # On-chain
    ".sol",
)
"""What counts as reviewable source.

Deliberately broad. A narrow list does not merely miss files — it makes
`_fetch_github_code` raise `[EXTERNAL] No README or recognised source files`
and reject the submission outright, so every extension left out is a whole
category of freelance work the platform silently refuses. The first version of
this list held eight entries and would have turned away any Java, PHP, Ruby,
C#, C++, Swift, Kotlin, Vue or Svelte deliverable."""

MAX_SOURCE_FILES = 2
"""Ceiling on source-file fetches, so the content budget is README + 2 files.

Deliberately small. GitHub allows 60 unauthenticated requests per hour per IP,
and this path is paid by the leader AND by every validator in the set — which
may share egress. At 3 content fetches plus the listing that is 4 requests per
evaluation in the common case, so an IP supports roughly a dozen verifications
an hour. It was 3 files (6 requests worst case), which halved that headroom for
one extra file the 3000-character budget usually could not fit anyway."""

MAX_FILE_BYTES = 50000
"""Skip anything larger. A vendored bundle or a generated client would spend
the whole character budget on code nobody wrote."""

CODE_TEXT_CHARS = 3000
"""Total code budget handed to the prompt. Unchanged from the render path."""

README_CHARS = 800
"""The README states intent, so it earns a slice of the budget — but only a
slice. Letting prose crowd out source is exactly how the old path failed."""

README_PATH = "README.md"
"""The one README name probed speculatively, for context only.

Nothing hinges on finding it any more — the ref is resolved by `HEAD` and the
source probes below run whether or not it answered. So a miss costs a paragraph
of intent, not the evaluation: a `README.rst` repository still gets its source
files read, and if no source is found at all the listing pass locates any
`readme*` by name via `_find_readme`. Probing further spellings here would spend
a sequential CDN round trip per spelling on every repository that has none, to
recover prose that is explicitly capped at a quarter of the budget."""

SKIP_DIRS = (
    "node_modules", "dist", "build", "vendor", "target", "out",
    "coverage", ".git", "__pycache__", ".next", "venv", ".venv",
)
"""Matched per path SEGMENT, never as a substring — a bare `in` test would
also drop `webbuild/app.ts`, which is somebody's actual source."""

SKIP_FILENAMES = (
    "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "cargo.lock",
    "poetry.lock", "go.sum", "composer.lock",
)

MAX_SOURCE_LINE_CHARS = 500
"""A line longer than this is minifier output, not something a person typed."""

MIN_SOURCE_LINES = 3
"""Fewer lines than this and there is nothing to review."""

RAW_PROBE_PATHS = (
    "src/App.jsx", "src/App.tsx", "src/main.jsx", "src/main.tsx",
    "src/index.ts", "src/index.js", "src/main.rs",
    "main.py", "app.py", "index.js", "main.go",
)
"""Where an entrypoint conventionally lives, tried in order.

Guessing beats asking. `api.github.com` meters at 60 requests per hour per IP
and validator nodes share busy egress addresses, so the listing call returns
403 on the nodes that matter even when it succeeds from a developer's laptop.
`raw.githubusercontent.com` is served from the CDN and carries no such limit,
so a handful of speculative 404s against raw costs nothing that a single
metered API call does not cost more."""

MAX_RAW_PROBES = 12
"""Ceiling on the speculative raw requests, counting the misses.

Raw is unmetered, so this bounds latency rather than quota: each probe is a
sequential round trip inside the leader's budget, and a CDN hit is tens of
milliseconds against a verification that already pays for two screenshots and
an LLM call and is measured in minutes. Twelve cheap misses are cheaper than one
screenshot, which is why the ceiling is not lower.

Sized to clear one README probe plus every entry in `RAW_PROBE_PATHS` exactly,
which is load-bearing rather than slack. `RAW_PROBE_PATHS` is ordered JS-first,
so a lower ceiling does not degrade gracefully — it spends the whole budget
missing on React paths and never reaches `main.py`, and every Python, Go and
Rust repository silently scores as though it contained no code. A cap that
truncates the probe list is worse than no cap at all.

Resolving the ref through `HEAD` rather than guessing `main` then `master` is
what freed the probe this used to spend on a second README attempt."""

MAX_LISTING_FETCHES = 6
"""Ceiling on the file fetches made while walking a listing, counted separately
from `MAX_RAW_PROBES`.

The two budgets measure different things and must not share a counter. A raw
probe is a guess that is *expected* to miss; a listing walk fetches paths GitHub
has confirmed exist, and only overspends when the shallowest ones turn out to be
unmarked bundles that `_looks_minified` rejects after the fetch.

Sharing one counter was a live bug the moment the listing stopped being reachable
only from a standing start: a repository whose README answered and whose eleven
probes all missed arrived at the listing with the budget already exhausted, so
the walk broke on its first iteration and the model was handed the README alone
— the precise outcome the listing exists to prevent. Six clears four bundles and
still funds both source slots."""


def _parse_github_repo(url: str) -> dict:
    """
    owner / repo / branch out of a GitHub URL, or `{}` if it is not one.

    Accepts `github.com/owner/repo`, a trailing `.git`, trailing slashes, and
    `/tree/<branch>/...` paths. Anything else returns `{}` and the caller falls
    back to rendering the page, so a GitLab or self-hosted URL still works.
    """
    text = str(url).strip()
    lowered = text.lower()

    for prefix in ("https://", "http://"):
        if lowered.startswith(prefix):
            text = text[len(prefix):]
            lowered = lowered[len(prefix):]
            break
    if lowered.startswith("www."):
        text = text[4:]
        lowered = lowered[4:]
    if not lowered.startswith("github.com/"):
        return {}
    text = text[len("github.com/"):]

    # Drop query and fragment before splitting, or `?tab=readme` becomes part
    # of the repo name.
    for sep in ("?", "#"):
        cut = text.find(sep)
        if cut != -1:
            text = text[:cut]

    parts = []
    for piece in text.split("/"):
        if piece:
            parts.append(piece)
    if len(parts) < 2:
        return {}

    owner = parts[0]
    repo = parts[1]
    if repo.lower().endswith(".git"):
        repo = repo[:-4]
    if not owner or not repo:
        return {}

    # `/tree/<branch>` pins the branch explicitly. Anything deeper is a path
    # inside it, which is ignored — the tree call walks the whole repo anyway.
    branch = ""
    if len(parts) >= 4 and parts[2] == "tree":
        branch = parts[3]

    return {"owner": owner, "repo": repo, "branch": branch}


def _is_source_path(path: str) -> bool:
    """Whether a tree entry is source worth showing the model."""
    lowered = path.lower()
    if not lowered.endswith(SOURCE_EXTENSIONS):
        return False

    segments = lowered.split("/")
    name = segments[-1]
    if name in SKIP_FILENAMES:
        return False
    # `.min.` catches site.min.css and app.min.js before a request is spent on
    # them. Bundles without the marker are caught by `_looks_minified` after
    # the fetch, which is the only way to know.
    if ".min." in name:
        return False
    for directory in segments[:-1]:
        if directory in SKIP_DIRS:
            return False
    return True


def _looks_minified(text: str) -> bool:
    """Whether a fetched file is generated output rather than written source.

    Judged on content because the filename cannot be trusted: `bundle.js` and
    `vendor.css` carry no `.min.` marker and are exactly the files most likely
    to be machine-generated.

    Two signals, both cheap. A very long line is what a minifier produces, and
    a file with almost no lines has nothing in it to review. Either one costs a
    source slot to a single unreadable string in front of the model that
    decides whether somebody gets paid.

    Must be called on the WHOLE file, before the character budget truncates it
    — a long, perfectly ordinary file cut to its first two lines would
    otherwise look minified on the strength of our own truncation.
    """
    if not text.strip():
        return True

    lines = text.splitlines()
    if len(lines) < MIN_SOURCE_LINES:
        return True
    for line in lines:
        if len(line) > MAX_SOURCE_LINE_CHARS:
            return True
    return False


def _rank_source_files(entries: list) -> list:
    """
    The source files worth showing, best first.

    Sorted by depth then path so that the leader and every validator pick the
    same files from the same tree. Files nearer the root come first: those are
    the entry points and the code someone actually wrote, while depth usually
    means generated, vendored or peripheral.
    """
    candidates = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        if str(entry.get("type", "")) != "blob":
            continue

        path = str(entry.get("path", ""))
        if not path or not _is_source_path(path):
            continue

        try:
            if int(entry.get("size", 0)) > MAX_FILE_BYTES:
                continue
        except Exception:
            continue

        candidates.append((path.count("/"), path))

    candidates.sort()

    ranked = []
    for _depth, path in candidates:
        ranked.append(path)
    return ranked


def _find_readme(entries: list) -> str:
    """Path of the shallowest README, or "" when the repo has none."""
    best = ""
    best_depth = -1
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        if str(entry.get("type", "")) != "blob":
            continue

        path = str(entry.get("path", ""))
        if not path:
            continue
        if not path.lower().split("/")[-1].startswith("readme"):
            continue

        depth = path.count("/")
        if best_depth == -1 or depth < best_depth or (depth == best_depth and path < best):
            best = path
            best_depth = depth
    return best


GITHUB_HEADERS = {
    # GitHub's REST API returns 403 to any request without a User-Agent, so
    # this is required rather than polite.
    "User-Agent": "ProofWork-IntelligentContract",
    "Accept": "application/vnd.github+json",
}

RAW_HEADERS = {
    # raw.githubusercontent.com serves plain files and must NOT be sent the
    # API's Accept header — asking for `vnd.github+json` on a .py file is a
    # good way to be handed something that is not the file.
    "User-Agent": "ProofWork-IntelligentContract",
}


def _web_get(url: str, headers: dict) -> dict:
    """
    One bounded GET, as `{"status": int, "body": str}`.

    `web.get` hands back a `Response` dataclass — `status`, `headers`, and a
    `body` of BYTES — not a string. Stringifying the response object itself
    would quietly yield its repr, and the model would then be asked to review
    `Response(status=200, ...)` as though it were somebody's source code. So
    the status is read and the body decoded explicitly.

    The status is returned rather than folded into "" because the callers must
    tell "404, that branch does not exist" from "403, GitHub is rate-limiting
    this validator". Those need opposite handling: one is a fact every
    validator sees alike, the other is a reason to stop and retry.

    `status` 0 means the request never completed at all.
    """
    try:
        response = gl.nondet.web.get(url, headers=headers)
        status = int(response.status)
        body = response.body
        if body is None:
            text = ""
        elif isinstance(body, bytes):
            # `replace` rather than strict: a stray non-UTF-8 byte in one file
            # must not take down the whole evaluation.
            text = body.decode("utf-8", "replace")
        else:
            text = str(body)
        return {"status": status, "body": text}
    except Exception:
        return {"status": 0, "body": ""}


def _is_transient_status(status: int) -> bool:
    """Whether a status means "ask again" rather than "this is the answer".

    0 is a request that never completed. 403 is what GitHub returns for the
    unauthenticated rate limit — it does not use 429 for that, though 429 is
    included for the proxies that do. 5xx is GitHub's problem, not the
    submission's.

    Everything else, 404 included, is a fact about the repository that every
    validator observes identically and can safely act on.
    """
    return status == 0 or status == 403 or status == 429 or status >= 500


def _fetch_github_code(github_url: str) -> str:
    """
    Real source out of a GitHub repository: the README plus the first couple of
    source files, each under a `// FILE:` header so the model can tell them
    apart.

    Fails CLOSED. There is deliberately no fall back to rendering the page from
    here, because this runs on the leader *and* on every validator: if one side
    reached the API and another was rate-limited into rendering the landing
    page instead, the two would fingerprint entirely different content and the
    validator would reject honest evidence — reading as a dishonest leader
    rather than as the network problem it is.

    So a transient failure raises `[TRANSIENT]`, which `_compare_user_errors`
    treats as agreement when both sides hit one, and the whole verification
    reverts cleanly for the caller to retry. A 404 is different: every
    validator sees it identically, so it raises `[EXTERNAL]`, which must match
    exactly and does.
    """
    repo = _parse_github_repo(github_url)
    if not repo:
        return ""

    owner = str(repo["owner"])
    name = str(repo["repo"])
    pinned = str(repo["branch"])

    # A `/tree/<branch>/` URL pins the branch the client actually linked; with
    # nothing pinned, `HEAD` resolves the repository's real default. Either way
    # there is exactly ONE ref, settled before the first request and never
    # revised by what a fetch happened to return — see `GITHUB_DEFAULT_REF`.
    ref = pinned if pinned else GITHUB_DEFAULT_REF

    def _raw(path: str) -> str:
        """One file from raw.githubusercontent.com, whole.

        Raises on transient, returns "" on a plain 404. Untruncated so the
        caller can judge it before the budget cuts it down — see
        `_looks_minified`.
        """
        got = _web_get(
            f"https://raw.githubusercontent.com/{owner}/{name}/{ref}/{path}",
            RAW_HEADERS,
        )
        code = int(got["status"])
        if _is_transient_status(code):
            raise gl.vm.UserError(
                f"{ERROR_TRANSIENT} GitHub returned {code} fetching {path}; "
                f"the evidence was not read. Verify again."
            )
        if code != 200:
            return ""
        return str(got["body"])

    pieces = []
    used = 0
    accepted = 0
    probes = 0
    have_readme = False

    # ── Pass 1: raw, by convention ──
    #
    # The README is fetched for context and is not a gate: whether it answers or
    # 404s, the source probes below run against the same already-settled ref.
    probes += 1
    body = _raw(README_PATH)
    if body:
        chunk = f"// FILE: {README_PATH}\n{body[:README_CHARS]}"
        pieces.append(chunk)
        used += len(chunk)
        have_readme = True

    for path in RAW_PROBE_PATHS:
        if accepted >= MAX_SOURCE_FILES or probes >= MAX_RAW_PROBES:
            break
        room = CODE_TEXT_CHARS - used
        if room <= 0:
            break

        probes += 1
        body = _raw(path)
        if not body or _looks_minified(body):
            continue

        chunk = f"// FILE: {path}\n{body}"[:room]
        pieces.append(chunk)
        used += len(chunk)
        accepted += 1

    # ── Pass 2: the listing API, only when convention found no SOURCE ──
    #
    # The gate is `accepted == 0`, NOT an empty `pieces`. A README is not code.
    # Gating on `pieces` meant any repository that had a README but kept its
    # source somewhere the probe list does not guess was declared complete on
    # the strength of its prose, and the model was asked for a `code_quality`
    # score having been shown no code — which is job 16: functionality 72,
    # completeness 68, code_quality 0, rejected at 45, on evidence no validator
    # ever saw. Django (`<app>/views.py`), Rails (`app/models/`), Maven
    # (`src/main/java/...`), pnpm/turbo monorepos (`packages/*/src/`) and Go's
    # `cmd/server/main.go` all land there, so this was not an edge case.
    #
    # ONE call. This is the expensive path in the only sense that matters:
    # api.github.com meters at 60 requests per hour per IP, and validator nodes
    # share busy egress addresses, so in practice it returns 403 regardless of
    # how little this contract asks of it. raw.githubusercontent.com is not
    # subject to that limit, which is why every request above prefers it.
    if accepted == 0:
        result = _web_get(
            f"https://api.github.com/repos/{owner}/{name}"
            f"/git/trees/{ref}?recursive=1",
            GITHUB_HEADERS,
        )
        status = int(result["status"])

        if status == 200:
            try:
                parsed = json.loads(result["body"])
            except Exception:
                parsed = None

            if isinstance(parsed, dict) and isinstance(parsed.get("tree"), list):
                tree = parsed["tree"]

                # Only when pass 1 did not already supply one, or a repository
                # holding both `README.md` and `README.rst` would spend a fetch
                # and a chunk of the budget on the same prose twice.
                if not have_readme:
                    readme_path = _find_readme(tree)
                    if readme_path:
                        body = _raw(readme_path)
                        if body:
                            chunk = f"// FILE: {readme_path}\n{body[:README_CHARS]}"
                            pieces.append(chunk)
                            used += len(chunk)
                            have_readme = True

                fetches = 0
                for path in _rank_source_files(tree):
                    if accepted >= MAX_SOURCE_FILES or fetches >= MAX_LISTING_FETCHES:
                        break
                    room = CODE_TEXT_CHARS - used
                    if room <= 0:
                        break

                    fetches += 1
                    body = _raw(path)
                    if not body or _looks_minified(body):
                        continue

                    chunk = f"// FILE: {path}\n{body}"[:room]
                    pieces.append(chunk)
                    used += len(chunk)
                    accepted += 1

        elif _is_transient_status(status):
            # No source was read by either route, so there is nothing to score
            # `code_quality` against and the call must not proceed. Raising here
            # can now discard a README that pass 1 did fetch, and that is the
            # point: reverting a verification is retryable, whereas scoring
            # prose as code rejects a milestone permanently and wrongly.
            #
            # The cost is that a leader who reaches the listing while a
            # validator is rate-limited gets a mismatch — the validator raises
            # while the leader succeeded — and the transaction reverts for the
            # caller to retry. That trade is deliberate: a retry costs time, a
            # false rejection costs the freelancer the milestone.
            raise gl.vm.UserError(
                f"{ERROR_TRANSIENT} GitHub returned {status} listing "
                f"{owner}/{name}, and no source file could be read directly. "
                f"Verify again."
            )

    if not pieces:
        # Every route came back a clean 404. Deterministic, so validators agree
        # — and far more honest than handing the prompt an empty repository and
        # letting the model score the silence.
        raise gl.vm.UserError(
            f"{ERROR_EXTERNAL} Could not read any file from {owner}/{name}. "
            f"Check the repository is public"
            + (f" and that branch `{pinned}` exists." if pinned else ".")
        )

    return "\n\n".join(pieces)[:CODE_TEXT_CHARS]


def _gather_evidence(github_url: str, site_url: str) -> dict:
    """
    Fetch the text evidence. No LLM — this is the half a validator can afford.

    Screenshots are not fetched here and not fingerprinted: they are bytes that
    differ between any two renders, so they cannot be compared, and they exist
    only to feed the design-match prompt.
    """
    code_text = ""
    site_text = ""
    if github_url:
        # The two paths are chosen by the URL alone, never by whether a fetch
        # succeeded. That is what keeps the leader and every validator on the
        # SAME path for the same submission: a fallback triggered by failure
        # would put a rate-limited validator on `render` while the leader used
        # the API, and the resulting fingerprint mismatch would look like a
        # lying leader instead of a busy network.
        if _parse_github_repo(github_url):
            code_text = _fetch_github_code(github_url)
        else:
            # Not GitHub — GitLab, Bitbucket, a self-hosted forge. Render the
            # page, which is what every side does here, so they still agree.
            code_text = str(gl.nondet.web.render(github_url, mode="text"))[
                :CODE_TEXT_CHARS
            ]
    if site_url:
        site_text = str(gl.nondet.web.render(site_url, mode="text"))[:2000]

    if not code_text and not site_text:
        raise gl.vm.UserError(
            f"{ERROR_EXTERNAL} No evidence could be fetched from the submitted URLs"
        )

    return {
        "code_text": code_text,
        "site_text": site_text,
        "code_len": len(_normalize(code_text)),
        "site_len": len(_normalize(site_text)),
        "code_fp": _fingerprint(code_text),
        "site_fp": _fingerprint(site_text),
    }


def _gather_and_score(
    github_url: str,
    site_url: str,
    mockup_url: str,
    requirements: str,
    milestone_desc: str,
    weights: dict,
) -> dict:
    """
    The leader's half: fetch evidence, then score it with ONE LLM call.

    Returns the scores together with a fingerprint of the evidence they were
    derived from, so a validator can confirm the leader scored the real page
    without paying for an LLM call of its own. See `verify_milestone` for why
    that split exists.

    Everything captured here is a plain str/int/dict — it gets cloudpickled to
    reach the leader, and anything storage-backed kills the block before it
    runs.
    """
    ev = _gather_evidence(github_url, site_url)

    # Screenshots are the most expensive fetch, so take them only when there is
    # actually a mockup to compare against.
    shots: list = []
    if site_url and mockup_url and int(weights.get("design", 0)) > 0:
        shots = [
            gl.nondet.web.render(site_url, mode="screenshot"),
            gl.nondet.web.render(mockup_url, mode="screenshot"),
        ]

    prompt = _evidence_prompt(
        str(ev["code_text"]),
        str(ev["site_text"]),
        milestone_desc,
        requirements,
        weights,
        bool(shots),
    )

    if shots:
        reply = gl.nondet.exec_prompt(prompt, response_format="json", images=shots)
    else:
        reply = gl.nondet.exec_prompt(prompt, response_format="json")

    scores = _extract_scores(reply, weights)

    # Carry the evidence fingerprint out with the scores. Not the page text —
    # that would bloat the value that goes through consensus and gets stored.
    scores["code_len"] = int(ev["code_len"])
    scores["site_len"] = int(ev["site_len"])
    scores["code_fp"] = str(ev["code_fp"])
    scores["site_fp"] = str(ev["site_fp"])
    return scores


def _lengths_agree(leader_len: int, own_len: int) -> bool:
    """Page lengths from two separate fetches, within tolerance."""
    if leader_len == own_len:
        return True
    bigger = leader_len if leader_len > own_len else own_len
    diff = leader_len - own_len
    if diff < 0:
        diff = -diff
    # Absolute floor so tiny pages are not held to an impossible percentage.
    if diff <= EVIDENCE_LEN_FLOOR:
        return True
    return diff * 100 <= bigger * EVIDENCE_LEN_TOLERANCE_PCT


def _evidence_matches(leader_scores: dict, own_evidence: dict) -> bool:
    """
    Did the leader score the same pages this validator just fetched?

    This is what the validator can verify without an LLM call: not whether the
    leader's judgement was right, but whether the evidence behind it was real
    and unaltered. A leader cannot invent a repo, point the scorer at a
    different page, or score a URL it never fetched.
    """
    if str(leader_scores.get("code_fp", "")) != str(own_evidence["code_fp"]):
        return False
    if str(leader_scores.get("site_fp", "")) != str(own_evidence["site_fp"]):
        return False
    if not _lengths_agree(
        int(leader_scores.get("code_len", -1)), int(own_evidence["code_len"])
    ):
        return False
    if not _lengths_agree(
        int(leader_scores.get("site_len", -1)), int(own_evidence["site_len"])
    ):
        return False
    return True


def _scores_well_formed(leader_scores: dict) -> bool:
    """Every axis present and in range. Cheap, but it is the only guard against
    a leader returning a score the contract would then pay out on."""
    for key in SCORE_KEYS:
        if key not in leader_scores:
            return False
        value = int(leader_scores[key])
        if value < 0 or value > 100:
            return False
    return True


def _compare_user_errors(leader_err: object, validator_err: object) -> bool:
    """
    How a validator should treat a failure the leader also hit.

    Deterministic failures (a 404 repo, a rejected milestone) must match
    exactly. A transient network failure on both sides is agreement. An LLM
    failure is never agreement — disagreeing rotates the validator set, which
    is the only thing that gets past a model that will not emit valid JSON.
    """
    leader_msg = str(getattr(leader_err, "message", leader_err))
    validator_msg = str(getattr(validator_err, "message", validator_err))

    if leader_msg.startswith(ERROR_LLM) or validator_msg.startswith(ERROR_LLM):
        return False
    if leader_msg.startswith(ERROR_TRANSIENT) and validator_msg.startswith(
        ERROR_TRANSIENT
    ):
        return True
    return leader_msg == validator_msg


class ProofWork(gl.Contract):
    jobs: TreeMap[u32, Job]
    milestones: TreeMap[str, Milestone]
    job_count: u32
    freelancer_scores: TreeMap[str, str]
    freelancer_job_count: TreeMap[str, u32]

    def __init__(self):
        self.job_count = u32(0)

    # ─────────────────────────────────────────
    # CLIENT: Create a job with milestones
    # ─────────────────────────────────────────
    @gl.public.write.payable
    def create_job(
        self,
        title: str,
        requirements: str,
        milestone_descriptions: str,
        milestone_percentages: str,
        deadline_seconds: u64,
        stake_percentage: u32,
    ) -> u32:
        amount = gl.message.value
        if amount == 0:
            raise gl.vm.UserError("Must deposit GEN for escrow")

        descs = milestone_descriptions.split("|")
        pcts = milestone_percentages.split("|")

        if len(descs) != len(pcts):
            raise gl.vm.UserError("Milestone descriptions and percentages must match")

        total_pct = u32(0)
        for p in pcts:
            total_pct = u32(total_pct + u32(int(p.strip())))

        if total_pct != u32(100):
            raise gl.vm.UserError("Milestone percentages must sum to 100")

        if int(deadline_seconds) <= 0:
            raise gl.vm.UserError("Deadline must be more than zero seconds away")

        if int(stake_percentage) > MAX_STAKE_PCT:
            raise gl.vm.UserError(f"Stake percentage must be between 0 and {MAX_STAKE_PCT}")

        # Refuse to create a job whose deadline can never be evaluated. Storing
        # one anyway would produce escrow that neither party could ever release
        # through the deadline path.
        now = _epoch_now()
        if now == 0:
            raise gl.vm.UserError("Cannot read transaction time; try again")

        # Divide before multiplying: the multiply-first form overflows u64 once
        # total_amount passes u64_max/100, the same reason the payout branch is
        # written this way.
        required_stake = u64(u64(amount) // u64(100) * u64(int(stake_percentage)))

        job_id = self.job_count
        self.job_count = u32(self.job_count + u32(1))

        self.jobs[job_id] = Job(
            client=gl.message.sender_address,
            freelancer=Address("0x" + "0" * 40),
            title=title,
            requirements=requirements,
            total_amount=u64(amount),
            status="open",
            milestone_count=u32(len(descs)),
            completed_milestones=u32(0),
            deadline=u64(now + int(deadline_seconds)),
            required_stake=required_stake,
            freelancer_stake=u64(0),
            accepted_at=u64(0),
            paid_out=u64(0),
        )

        for i in range(len(descs)):
            key = f"{job_id}:{i}"
            self.milestones[key] = Milestone(
                description=descs[i].strip(),
                percentage=u32(int(pcts[i].strip())),
                status="pending",
                github_url="",
                site_url="",
                mockup_url="",
                code_score=u32(0),
                design_score=u32(0),
                functionality_score=u32(0),
                completeness_score=u32(0),
                final_score=u32(0),
            )

        return job_id

    # ─────────────────────────────────────────
    # FREELANCER: Accept a job
    # ─────────────────────────────────────────
    @gl.public.write.payable
    def accept_job(self, job_id: u32) -> None:
        job = self.jobs[job_id]
        if job.status != "open":
            raise gl.vm.UserError("Job is not open")

        if gl.message.sender_address == job.client:
            raise gl.vm.UserError("Client cannot accept their own job")

        zero_addr = Address("0x" + "0" * 40)
        if job.freelancer != zero_addr:
            raise gl.vm.UserError("Job already taken")

        # The stake is the whole anti-scam mechanism: without skin in the game
        # a freelancer can take a job, sit on it, and cost the client the
        # deadline for nothing. Exact equality, not a minimum — an overpayment
        # would sit in the contract with no rule saying who gets it back.
        staked = gl.message.value
        if int(staked) != int(job.required_stake):
            raise gl.vm.UserError(
                f"Must stake exactly {int(job.required_stake)} to accept this job"
            )

        now = _epoch_now()
        if now == 0:
            raise gl.vm.UserError("Cannot read transaction time; try again")

        # Deliberately allowed after the deadline has passed. The client can
        # withdraw the offer with cancel_job at any time while it is open, and
        # a freelancer who knowingly accepts a late job has taken on the
        # abandonment risk with their own stake.
        job.freelancer = gl.message.sender_address
        job.status = "in_progress"
        job.freelancer_stake = u64(int(staked))
        job.accepted_at = u64(now)
        self.jobs[job_id] = job

    # ─────────────────────────────────────────
    # FREELANCER: Submit evidence for milestone
    # ─────────────────────────────────────────
    @gl.public.write
    def submit_milestone(
        self,
        job_id: u32,
        milestone_id: u32,
        github_url: str,
        site_url: str,
        mockup_url: str,
    ) -> None:
        job = self.jobs[job_id]
        if job.status != "in_progress":
            raise gl.vm.UserError("Job is not in progress")

        if gl.message.sender_address != job.freelancer:
            raise gl.vm.UserError("Only assigned freelancer can submit")

        key = f"{job_id}:{milestone_id}"
        ms = self.milestones[key]

        if ms.status != "pending" and ms.status != "rejected":
            raise gl.vm.UserError("Milestone not awaiting submission")

        ms.github_url = github_url
        ms.site_url = site_url
        ms.mockup_url = mockup_url
        ms.status = "submitted"
        self.milestones[key] = ms

    # ─────────────────────────────────────────
    # VERIFY: AI-powered milestone verification
    # ─────────────────────────────────────────
    @gl.public.write
    def verify_milestone(self, job_id: u32, milestone_id: u32) -> None:
        job = self.jobs[job_id]
        key = f"{job_id}:{milestone_id}"
        ms = self.milestones[key]

        # The job's status, not just the milestone's. `abandon_job` refunds the
        # escrow and moves the job to "abandoned" without touching individual
        # milestones, so one left sitting in "submitted" stayed verifiable
        # against money that had already gone back to the client:
        # `total_amount` is never zeroed, so the payout branch below would fire
        # against an escrow that no longer exists, push `paid_out` past
        # `total_amount`, and — if it happened to be the last milestone — flip
        # the job from "abandoned" back to "completed" and return the stake the
        # client had already been paid.
        #
        # Checked first because it is the cheaper and more fundamental of the
        # two: a milestone's state is only meaningful while its job is live.
        if job.status != "in_progress":
            raise gl.vm.UserError("Job is not in progress")

        if ms.status != "submitted":
            raise gl.vm.UserError("Milestone not submitted for review")

        job_mem = gl.storage.copy_to_memory(job)
        ms_mem = gl.storage.copy_to_memory(ms)

        # The str() calls are load-bearing, not cosmetic.
        #
        # copy_to_memory does NOT hand back plain Python strings — the attributes
        # stay storage-backed. Capturing one directly in an eq_principle lambda
        # makes GenVM try to pickle a storage class to set up the block, which
        # fails with "Detected pickling storage class. Reading storage in nondet
        # mode is not supported" and kills the leader. Every verification
        # reverted this way until 2026-07-20.
        #
        # Confirmed by probe (test/probe_capture.py) on three methods differing
        # only in this: capturing `mem.text` raw -> LEADER_TIMEOUT/NOT_VOTED;
        # capturing `str(mem.text)` -> FINISHED_WITH_RETURN. A plain storage
        # `str` field captured raw is fine, so it is specifically the
        # copy_to_memory'd dataclass attributes that need converting.
        requirements = str(job_mem.requirements)
        milestone_desc = str(ms_mem.description)
        github_url = str(ms_mem.github_url)
        site_url = str(ms_mem.site_url)
        mockup_url = str(ms_mem.mockup_url)

        # ── Determine which checks apply based on evidence provided ──
        #
        # A URL counts as supplied only if it is fetchable — see
        # `_is_usable_url`. Testing against the "none" sentinel alone let any
        # stray word through, and an unfetchable mockup does not merely score
        # badly: it weights design at 25% and then sends a screenshot render at
        # a string that is not a URL, which is how a live submission with
        # `mockup_url="nope"` settled UNDETERMINED.
        #
        # Deterministic, and computed before the nondet block, so every
        # validator classifies the same submission the same way.
        has_code = _is_usable_url(github_url)
        has_site = _is_usable_url(site_url)
        has_mockup = _is_usable_url(mockup_url)

        if not has_code and not has_site:
            raise gl.vm.UserError(
                f"{ERROR_EXPECTED} Must provide at least a GitHub URL or deployed site URL"
            )

        # ── Dynamic weights based on available evidence ──
        # All 4 checks: 25 each. No mockup: code 35, func 35, comp 30.
        # No site: code 50, comp 50. No repo: func/comp carry it.
        # Plain ints, not u32 — these cross into the nondet closures below.
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

        code_url = github_url if has_code else ""
        live_url = site_url if has_site else ""
        design_url = mockup_url if has_mockup else ""

        # ── One consensus round for all four scores ──
        #
        # This used to be four `prompt_non_comparative` blocks run back to
        # back. That failed two different ways: each block asked every
        # validator to independently affirm a subjective number, which never
        # converged (UNDETERMINED across 11 revealed votes), and four rounds of
        # 7 renders and 4 prompts per validator timed the validator set out on
        # any real deliverable.
        #
        # One block, one prompt, each URL fetched once — and a validator that
        # reruns the evaluation and compares the *decision* rather than
        # affirming the leader's exact number.
        def leader_fn() -> dict:
            return _gather_and_score(
                code_url, live_url, design_url, requirements, milestone_desc, weights
            )

        def validator_fn(leader_result: gl.vm.Result) -> bool:
            if not isinstance(leader_result, gl.vm.Return):
                # The leader raised. Re-fetch rather than returning False here:
                # if we fail the same way, this call raises inside run_nondet's
                # sandbox and `_compare_user_errors` gets to decide whether
                # matching failures count as agreement. Returning False instead
                # would make every leader error a disagreement, so a genuinely
                # unreachable repo could never revert cleanly — it would burn
                # rounds and land UNDETERMINED, stranding the milestone in
                # `submitted` with nothing to explain why.
                #
                # Only the fetch is repeated, not the scoring: an unreachable
                # URL is exactly the error worth agreeing about, and it raises
                # here without costing an LLM call.
                #
                # If we succeed where the leader failed, that IS disagreement.
                _gather_evidence(code_url, live_url)
                return False

            leader_scores = leader_result.calldata
            if not isinstance(leader_scores, dict):
                return False

            # Guard the payout first: a malformed or out-of-range score is
            # something the contract would otherwise pay out on.
            if not _scores_well_formed(leader_scores):
                return False

            # Re-fetch the evidence — NOT the scoring. See the note on
            # EVIDENCE_FINGERPRINT_CHARS for why the LLM call is not repeated.
            own_evidence = _gather_evidence(code_url, live_url)
            return _evidence_matches(leader_scores, own_evidence)

        scores = gl.vm.run_nondet(
            leader_fn, validator_fn, compare_user_errors=_compare_user_errors
        )

        code_s = u32(_clamp_score(int(scores.get("code", 0))))
        design_s = u32(_clamp_score(int(scores.get("design", 0))))
        func_s = u32(_clamp_score(int(scores.get("functionality", 0))))
        comp_s = u32(_clamp_score(int(scores.get("completeness", 0))))

        code_weight = u32(weights["code"])
        design_weight = u32(weights["design"])
        func_weight = u32(weights["functionality"])
        comp_weight = u32(weights["completeness"])

        # ── Weighted final score ──
        # Same helper the validator-side code paths use, rather than a second
        # copy of the arithmetic in u32 form — the two drifting apart would mean
        # the score shown and the score paid on could differ.
        final = u32(_weighted_final(scores, weights))

        # ── Update milestone ──
        ms.code_score = code_s
        ms.design_score = design_s
        ms.functionality_score = func_s
        ms.completeness_score = comp_s
        ms.final_score = final

        # ── Determine payment based on score ──
        # Same threshold the validator gates on, deliberately — if these two
        # ever disagree, validators would be agreeing about a payment decision
        # the contract then makes differently.
        if final >= u32(PASS_THRESHOLD):
            ms.status = "verified"
            job.completed_milestones = u32(job.completed_milestones + u32(1))

            # Calculate payment: (total_amount / 100 * milestone_pct) * score_pct / 100
            # Divide before multiplying in each step: the intermediate product of
            # a multiply-first form overflows u64 once the operand exceeds
            # u64_max / 100. Costs at most 99 base units of truncation per step,
            # which is dust at 18 decimals.
            milestone_amount = u64(u64(job.total_amount) // u64(100) * u64(ms.percentage))

            if final >= u32(90):
                payout = milestone_amount
            elif final >= u32(80):
                payout = u64(milestone_amount // u64(100) * u64(80))
            else:
                payout = u64(milestone_amount // u64(100) * u64(70))

            # Send payment to freelancer
            _Payee(job.freelancer).emit_transfer(value=u256(int(payout)))
            # Track it so an abandonment refunds only what is genuinely left.
            job.paid_out = u64(int(job.paid_out) + int(payout))
        else:
            # Rejected: the stake stays locked. It is released only by
            # finishing every milestone, or forfeited by abandonment — a
            # freelancer cannot walk away from a bad verdict with it.
            ms.status = "rejected"

        self.milestones[key] = ms

        # ── Check if all milestones done ──
        if job.completed_milestones == job.milestone_count:
            job.status = "completed"

            # Return the stake. It has done its job: every milestone passed, so
            # there is nothing left to deter. Zeroed first so the transfer can
            # never be replayed against a later read of the same field.
            stake_back = u64(int(job.freelancer_stake))
            if int(stake_back) > 0:
                job.freelancer_stake = u64(0)
                _Payee(job.freelancer).emit_transfer(value=u256(int(stake_back)))

            # Return what the score bands left behind.
            #
            # A milestone scoring 70-89 releases only 70% or 80% of its share,
            # and until now the remainder had no way out at all: `abandon_job`
            # requires an unverified milestone and `cancel_job` requires an
            # open job, so the moment the last milestone verified, 10-30% of
            # the escrow was locked in this contract permanently — on the
            # ordinary happy path of a job that was merely good rather than
            # excellent. It belongs to the client, who never agreed to pay for
            # work the contract itself decided was worth less.
            #
            # `paid_out` is raised to the full escrow BEFORE the transfer, the
            # same ordering as the stake above, so the remainder can never be
            # released twice by a later read of the field.
            #
            # This also sweeps the truncation dust from the divide-before-
            # multiply payout arithmetic, so a job that scored 90+ throughout
            # still settles to exactly zero rather than leaving a few base
            # units behind.
            remainder = int(job.total_amount) - int(job.paid_out)
            if remainder > 0:
                job.paid_out = u64(int(job.total_amount))
                _Payee(job.client).emit_transfer(value=u256(remainder))

            # Update freelancer reputation
            addr_str = str(job.freelancer)
            existing = self.freelancer_scores.get(addr_str, "")
            if existing:
                self.freelancer_scores[addr_str] = existing + "," + str(int(final))
            else:
                self.freelancer_scores[addr_str] = str(int(final))
            self.freelancer_job_count[addr_str] = u32(
                self.freelancer_job_count.get(addr_str, u32(0)) + u32(1)
            )

        self.jobs[job_id] = job

    # ─────────────────────────────────────────
    # CLIENT: Cancel open job and refund
    # ─────────────────────────────────────────
    @gl.public.write
    def cancel_job(self, job_id: u32) -> None:
        job = self.jobs[job_id]
        if gl.message.sender_address != job.client:
            raise gl.vm.UserError("Only client can cancel")
        if job.status != "open":
            raise gl.vm.UserError("Can only cancel open jobs")

        job.status = "cancelled"
        self.jobs[job_id] = job

        _Payee(job.client).emit_transfer(value=u256(int(job.total_amount)))

    # ─────────────────────────────────────────
    # CLIENT: Abandon a job that blew its deadline
    # ─────────────────────────────────────────
    @gl.public.write
    def abandon_job(self, job_id: u32) -> None:
        """Reclaim escrow from a freelancer who took the job and did not deliver.

        The counterpart to `cancel_job`: that one covers a job nobody has taken
        yet and refunds only escrow. This one covers a job that is in progress
        past its deadline, and additionally forfeits the freelancer's stake to
        the client. Milestones already verified were already paid and are not
        clawed back — the freelancer keeps what they actually delivered.
        """
        job = self.jobs[job_id]

        if gl.message.sender_address != job.client:
            raise gl.vm.UserError("Only client can abandon")

        if job.status != "in_progress":
            raise gl.vm.UserError("Can only abandon a job that is in progress")

        if job.completed_milestones >= job.milestone_count:
            raise gl.vm.UserError("Every milestone is verified; nothing to abandon")

        now = _epoch_now()
        if now == 0:
            raise gl.vm.UserError("Cannot read transaction time; try again")

        if now <= int(job.deadline):
            raise gl.vm.UserError(
                f"Deadline has not passed yet ({int(job.deadline) - now}s remaining)"
            )

        # What is left of escrow, plus the forfeited stake. `paid_out` is
        # subtracted rather than recomputed from milestone percentages because
        # the score bands mean a verified milestone may have released only 70%
        # or 80% of its share — the remainder stayed in the contract and
        # belongs to the client.
        remaining = int(job.total_amount) - int(job.paid_out)
        if remaining < 0:
            remaining = 0
        forfeited = int(job.freelancer_stake)

        # Zero before transferring so neither amount can be released twice.
        job.freelancer_stake = u64(0)
        job.paid_out = u64(int(job.total_amount))
        job.status = "abandoned"
        self.jobs[job_id] = job

        total_back = remaining + forfeited
        if total_back > 0:
            _Payee(job.client).emit_transfer(value=u256(total_back))

    # ─────────────────────────────────────────
    # VIEW: Get job details
    # ─────────────────────────────────────────
    @gl.public.view
    def get_job(self, job_id: u32) -> str:
        job = self.jobs[job_id]
        return json.dumps(
            {
                "client": str(job.client),
                "freelancer": str(job.freelancer),
                "title": job.title,
                "requirements": job.requirements,
                "total_amount": int(job.total_amount),
                "status": job.status,
                "milestone_count": int(job.milestone_count),
                "completed_milestones": int(job.completed_milestones),
                "deadline": int(job.deadline),
                "required_stake": int(job.required_stake),
                "freelancer_stake": int(job.freelancer_stake),
                "accepted_at": int(job.accepted_at),
                "paid_out": int(job.paid_out),
                # The chain's own clock, so a client cannot be told the
                # deadline has passed by a browser with a skewed system time.
                "now": _epoch_now(),
            }
        )

    # ─────────────────────────────────────────
    # VIEW: Get milestone details with scores
    # ─────────────────────────────────────────
    @gl.public.view
    def get_milestone(self, job_id: u32, milestone_id: u32) -> str:
        key = f"{job_id}:{milestone_id}"
        ms = self.milestones[key]
        return json.dumps(
            {
                "description": ms.description,
                "percentage": int(ms.percentage),
                "status": ms.status,
                "github_url": ms.github_url,
                "site_url": ms.site_url,
                "mockup_url": ms.mockup_url,
                "scores": {
                    "code_quality": int(ms.code_score),
                    "design_match": int(ms.design_score),
                    "functionality": int(ms.functionality_score),
                    "completeness": int(ms.completeness_score),
                    "final_weighted": int(ms.final_score),
                },
            }
        )

    # ─────────────────────────────────────────
    # VIEW: Get freelancer reputation
    # ─────────────────────────────────────────
    @gl.public.view
    def get_reputation(self, freelancer: str) -> str:
        scores_str = self.freelancer_scores.get(freelancer, "")
        job_count = int(self.freelancer_job_count.get(freelancer, u32(0)))

        if not scores_str:
            return json.dumps(
                {"address": freelancer, "jobs_completed": 0, "avg_score": 0, "scores": []}
            )

        scores = [int(s) for s in scores_str.split(",") if s]
        avg = sum(scores) // len(scores) if scores else 0

        return json.dumps(
            {
                "address": freelancer,
                "jobs_completed": job_count,
                "avg_score": avg,
                "scores": scores,
            }
        )

    # ─────────────────────────────────────────
    # VIEW: Get total jobs created
    # ─────────────────────────────────────────
    @gl.public.view
    def get_job_count(self) -> u32:
        return self.job_count
