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
    # Appended at the end on purpose: storage layout is positional, so
    # inserting above would shift every field after it. The model's own account
    # of what it read — display only, never read back by contract logic and
    # never part of consensus. See `_extract_scores`.
    reasoning: str


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

REASONING_ALIASES = ("reasoning", "reason", "analysis", "rationale", "explanation")
"""What the model might call its written justification.

Several spellings because, unlike a score, a miss here is silent — there is no
weight to notice its absence and no error to raise, so a model answering with
`rationale` would simply show a blank panel."""

REASONING_CHARS = 1500
"""Cap on the stored justification.

It goes into contract storage on every verified milestone, so it is bounded
rather than trusted. Whitespace is collapsed before the cut so the cap measures
content and not a model's indentation habits. Enough for a line-cited paragraph
per axis; short of an essay."""

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

    # ── The model's own account of what it read ──
    #
    # Carried out of the block for display, and DELIBERATELY not validated: it
    # is not compared by `_evidence_matches`, not required by
    # `_scores_well_formed`, and never gates a payout. A missing or malformed
    # `reasoning` costs a caption, not a milestone — which is the whole reason
    # it can be surfaced at all. Making consensus depend on free prose would
    # ask every validator to agree on a paragraph, and prose does not converge
    # the way four integers do.
    #
    # Read strictly as a claim BY the leader, not as a fact about the code. The
    # trust boundary is unchanged: validators still confirm the leader scored
    # the evidence they can themselves fetch, and nothing here widens that.
    # What it buys is falsifiability — citations name files and line numbers
    # that a reader can open, so a fabricated one is visible as fabricated.
    reasoning = ""
    for alias in REASONING_ALIASES:
        if alias in parsed:
            reasoning = str(parsed[alias])
            break
    scores["reasoning"] = " ".join(reasoning.split())[:REASONING_CHARS]

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
    inventory: str = "",
    kind: str = "",
) -> str:
    """
    One prompt covering all four criteria, aimed at the kind of project it is.

    Previously this was four separate prompts in four separate consensus
    blocks. Asking for all four scores at once is not just cheaper — it also
    lets the model see the whole deliverable before scoring any one axis,
    which is how a human reviewer would do it.

    `inventory` and `kind` come off the tree listing, and they are what make one
    prompt work for every project type. Without them the reviewer is handed a
    ranked sample with no idea what it is a sample OF: it cannot tell 5 files
    out of 5 from 12 out of 400, and it reviews a Solidity escrow with whatever
    criteria it would apply to a React page. Both default to empty so the
    non-GitHub render path — which has no listing to derive them from — still
    produces a valid prompt.
    """
    if code_text:
        # Said explicitly because it is the difference between "this feature is
        # missing" and "this feature is not in the excerpt". The evidence is a
        # ranked sample of a repository, and a model told nothing assumes it is
        # holding the whole thing: shown an entry file that imports `GMButton`
        # and no `GMButton.jsx`, it concluded the button did not exist.
        code_section = (
            "REPOSITORY CONTENT (an excerpt: the source files ranked most "
            "relevant to THIS milestone, each with its real length in its "
            "header — files not shown here still exist in the repository). "
            "Every line is numbered; cite those numbers:\n"
            f"{code_text}"
        )
    else:
        code_section = "REPOSITORY: not submitted for this milestone."

    if site_text:
        # The rendering conditions are stated because they are not the
        # freelancer's doing and must not be scored as defects. Measured on
        # Studionet with a throwaway probe contract: `web.render(mode="text")`
        # does execute JavaScript — a client-rendered SPA hydrates and its text
        # comes back — but it renders as an anonymous visitor. No wallet is
        # connected and nothing is clicked, so a wallet-gated dApp shows its
        # connect prompt and its on-chain counters render as placeholders. Read
        # literally, that page "does not work"; the button and the counters are
        # in the code and cannot be demonstrated any other way from here.
        site_section = (
            "DEPLOYED SITE TEXT (captured by an automated browser: JavaScript "
            "ran, but as an anonymous visitor with no wallet connected and no "
            "clicks — a connect prompt or an empty data placeholder is expected "
            "and is NOT a defect):\n"
            f"{site_text}"
        )
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
    # Named as the model is asked to name them (`SCORE_ALIASES[k][0]`), not by
    # our internal key — this line used to say "code, functionality" while the
    # criteria below it were headed `code_quality` and `functionality`.
    applicable = [SCORE_ALIASES[k][0] for k in SCORE_KEYS if int(weights.get(k, 0)) > 0]

    # What the repository IS, ahead of the excerpt from it. Stated before the
    # code because it changes how the code should be read: 12 files out of 400
    # is a sample and 5 out of 5 is the deliverable, and a reviewer who cannot
    # tell them apart scores `completeness` off an accident of ranking.
    if inventory:
        inventory_section = f"WHAT THIS REPOSITORY IS:\n{inventory}"
    else:
        inventory_section = ""

    # The type-aware half. A Solidity contract and a React screen are not
    # well-written in the same way, and one rubric applied to both scores
    # whichever it was written for.
    if kind:
        criteria_section = (
            f"HOW TO REVIEW THIS KIND OF PROJECT ({KIND_NAMES.get(kind, kind)}):\n"
            f"{_kind_guidance(kind)}"
        )
    else:
        criteria_section = ""

    return f"""You are reviewing a freelance deliverable against its milestone.
Your scores release or withhold real money, so judge the work in front of you on
its merits — neither generously nor defensively.

PROJECT REQUIREMENTS:
{requirements}

THIS MILESTONE:
{milestone_desc}

{inventory_section}

{criteria_section}

{code_section}

{site_section}

{image_section}

Score each of these 0-100. Scores that count for this submission: {", ".join(applicable)}.

- code_quality: does the code address the requirements, is it structured and
  readable, is it free of obvious bugs?
- design_match: how closely does the deployed site match the mockup in layout,
  colour and typography?
- functionality: does the site load, are the required features present and
  apparently working?
- completeness: what fraction of the milestone description is actually
  delivered, versus stubbed or missing?

Work through the evidence BEFORE you score. For each requirement above, find the
code or page text that implements it — then let the scores follow from what you
found. Fill in `reasoning` first and the numbers after it.

Your `reasoning` must be checkable. For each requirement, cite the evidence as
`path/to/file.ext:LINE` using the numbers shown in the left margin, and name the
function, contract, component or identifier you found there. A reader will open
those lines. Write only what you can point at:

- Requirement met: cite the file, the line, and the identifier that implements
  it — "escrow lock: contracts/Escrow.sol:88 `lockFunds()` transfers via
  SafeERC20".
- Requirement not found in the excerpt: say exactly that. "No ReentrancyGuard in
  the files shown" is a real and useful finding. Do NOT assume an unshown file
  implements it, and do NOT assume its absence proves it missing — say which.
- Never cite a file or line that does not appear above. An invented citation is
  worse than none: it is the one thing here a reader can catch, and it will be
  read as the whole review being fabricated.

Then, per axis, state in one sentence what the citations add up to before you
give the number.

Calibration — use the full range honestly:
- 90-100: meets the milestone in full, production quality. Example: every
  requirement traceable to real code, components separated cleanly, config in its
  own modules, no obvious bugs.
- 80-89: meets the milestone with minor gaps or rough edges. Example: all
  features implemented and working, but thin error handling, some duplication, or
  one requirement only partly honoured.
- 70-79: substantially delivered with real gaps. Example: the main feature works
  but a named secondary requirement is missing or clearly stubbed.
- 50-69: a genuine attempt at the milestone that does not deliver it — several
  requirements missing, or the central feature does not work.
- 1-49: fragments only. A scaffold with the milestone's features barely started.
- 0: reserved for NO attempt at that axis whatsoever.

Do not score 0 on an axis where an attempt exists, however flawed — 0 rejects the
milestone outright and pays nothing. Imperfect work belongs in the bands above.
Equally, do not award 90+ for a plausible-looking scaffold: name the code that
earns it.

If an axis is genuinely unjudgeable — no repository was submitted, or the site
text is empty — score it 0 and say so in `reasoning`. Judge only what is
present; do not penalise this submission for evidence it was never asked for.

Respond ONLY with a JSON object, no prose, no code fences, in this key order:
{{"reasoning": "<which file or page text satisfies each requirement, and what is missing>",
 "code_quality": <int>, "design_match": <int>, "functionality": <int>, "completeness": <int>}}
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
    ".py", ".rb", ".php", ".sh", ".sql", ".pl", ".lua", ".r", ".jl",
    # JS/TS and single-file component formats
    ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", ".svelte", ".astro",
    # Markup and styles — a front-end milestone may be almost entirely these
    ".html", ".css", ".scss", ".sass", ".less",
    # Compiled and systems languages
    ".java", ".cs", ".c", ".h", ".cpp", ".hpp", ".cc", ".go", ".rs",
    ".swift", ".kt", ".kts", ".scala", ".dart", ".ex", ".exs", ".erl",
    ".hs", ".clj", ".nim", ".zig", ".m", ".mm",
    # On-chain
    ".sol", ".vy", ".cairo", ".move",
    # Infrastructure as code — a devops milestone's whole deliverable
    ".tf",
    # Notebooks. Fetched as source but NOT handed over raw: a .ipynb is a JSON
    # document whose outputs can be megabytes of base64 image data, so
    # `_notebook_source` extracts the code cells and everything else is
    # discarded. Included because for a data-science or ML deliverable the
    # notebook frequently IS the deliverable, and a reviewer that cannot open
    # one scores the project on its requirements.txt.
    ".ipynb",
)
"""What counts as reviewable source.

Deliberately broad. A narrow list does not merely miss files — it makes
`_fetch_github_code` raise `[EXTERNAL] No README or recognised source files`
and reject the submission outright, so every extension left out is a whole
category of freelance work the platform silently refuses. The first version of
this list held eight entries and would have turned away any Java, PHP, Ruby,
C#, C++, Swift, Kotlin, Vue or Svelte deliverable.

This platform is open to anyone, so the list is maintained on the assumption
that the next submission is in a language nobody here has thought about. When
in doubt an extension goes IN: the cost of a wrong inclusion is one wasted file
slot that `_looks_minified` usually catches anyway, and the cost of a wrong
exclusion is a freelancer being told their repository contains no code."""

LANGUAGE_BY_EXTENSION = (
    # Ordered, and the FIRST match on a suffix wins, so `.tsx` must precede
    # `.ts` — otherwise every React component is counted as plain TypeScript
    # and a front-end project detects as a backend one.
    (".tsx", "TypeScript"), (".ts", "TypeScript"),
    (".jsx", "JavaScript"), (".mjs", "JavaScript"), (".cjs", "JavaScript"),
    (".js", "JavaScript"),
    (".vue", "Vue"), (".svelte", "Svelte"), (".astro", "Astro"),
    (".ipynb", "Jupyter notebook"), (".py", "Python"),
    (".sol", "Solidity"), (".vy", "Vyper"), (".cairo", "Cairo"),
    (".move", "Move"),
    (".go", "Go"), (".rs", "Rust"),
    (".java", "Java"), (".kts", "Kotlin"), (".kt", "Kotlin"),
    (".scala", "Scala"),
    (".swift", "Swift"), (".dart", "Dart"),
    (".rb", "Ruby"), (".php", "PHP"), (".cs", "C#"),
    (".cpp", "C++"), (".hpp", "C++"), (".cc", "C++"),
    (".c", "C"), (".h", "C/C++ header"),
    (".exs", "Elixir"), (".ex", "Elixir"), (".erl", "Erlang"),
    (".hs", "Haskell"), (".clj", "Clojure"), (".nim", "Nim"),
    (".zig", "Zig"), (".lua", "Lua"), (".pl", "Perl"),
    (".r", "R"), (".jl", "Julia"),
    (".mm", "Objective-C++"), (".m", "Objective-C"),
    (".scss", "SCSS"), (".sass", "Sass"), (".less", "Less"), (".css", "CSS"),
    (".html", "HTML"), (".sql", "SQL"), (".sh", "Shell"), (".tf", "Terraform"),
)
"""Extension to the language a reader would name it, for the inventory.

The point is not taxonomy — it is that the model is told "31 Solidity files, 4
TypeScript" before it is shown five of them, so it knows which of the two it is
reviewing and how much of the whole it is holding."""

FRAMEWORK_SIGNALS = (
    # Matched on a path's BASENAME, in this order, and every match is reported.
    # These are files whose mere presence names the toolchain — no content
    # needs fetching, so the whole detection is free once the tree is listed.
    ("next.config", "Next.js"),
    ("nuxt.config", "Nuxt"),
    ("remix.config", "Remix"),
    ("gatsby-config", "Gatsby"),
    ("angular.json", "Angular"),
    ("svelte.config", "SvelteKit"),
    ("astro.config", "Astro"),
    ("vite.config", "Vite"),
    ("tailwind.config", "Tailwind CSS"),
    ("hardhat.config", "Hardhat"),
    ("foundry.toml", "Foundry"),
    ("truffle-config", "Truffle"),
    ("anchor.toml", "Anchor"),
    ("manage.py", "Django"),
    ("pubspec.yaml", "Flutter"),
    ("dockerfile", "Docker"),
    ("docker-compose", "Docker Compose"),
    ("serverless.yml", "Serverless"),
    ("vercel.json", "Vercel"),
    ("netlify.toml", "Netlify"),
    ("terraform.tf", "Terraform"),
)
"""Configuration files that name a framework, so the stack is known from paths.

Deliberately structural rather than clever. `next.config.ts` in a repository
root is not a guess about what the project is — it is the project declaring it,
and a reviewer told "Next.js" reads `app/page.tsx` as a route rather than as a
file with an odd name."""

MAX_FRAMEWORKS = 6
"""How many toolchain labels the inventory reports.

A monorepo trips a dozen of these and a list that long stops being a summary."""

MANIFEST_FILENAMES = (
    # Ordered most-informative first: only `MAX_MANIFESTS` are fetched, and a
    # `package.json` says far more about what a project IS than a `Pipfile`.
    "package.json", "requirements.txt", "pyproject.toml", "cargo.toml",
    "go.mod", "pom.xml", "build.gradle", "build.gradle.kts", "gemfile",
    "composer.json", "pubspec.yaml", "package.swift", "mix.exs",
    "environment.yml", "pipfile", "setup.py", "deno.json",
)
"""Dependency manifests, fetched deliberately rather than ranked as source.

A manifest is the only place a repository states what it is BUILT FROM, and
that is a requirement in its own right — "must use React and ethers.js", "must
use ReentrancyGuard and SafeERC20" are claims a reviewer can check against
`package.json` in one line and cannot check from source excerpts at all.

They are excluded from `_rank_source_files` (they are not `SOURCE_EXTENSIONS`)
precisely so they never compete with implementation for a source slot. They get
their own small budget instead."""

MANIFEST_CHARS = 1200
"""Per-manifest slice. A manifest is metadata: enough to read the dependency
list, not enough to spend the code budget on a lockfile-shaped `package.json`
with 200 transitive pins."""

MAX_MANIFESTS = 2
"""Two, so a full-stack repository can show both `package.json` and
`requirements.txt` and be read as the two-language project it is."""

DEPENDENCY_SIGNALS = (
    # (token, label, kind). Matched as a SUBSTRING of a manifest token — see
    # `_manifest_tokens` — so `torch` also catches `pytorch-lightning` and
    # `@openzeppelin/contracts` catches on `openzeppelin`. Ordered, and every
    # match is reported; `kind` feeds `_project_kind`.
    ("openzeppelin", "OpenZeppelin", "contracts"),
    ("hardhat", "Hardhat", "contracts"),
    ("foundry", "Foundry", "contracts"),
    ("solc", "solc", "contracts"),
    ("ethers", "ethers.js", "contracts"),
    ("web3", "web3", "contracts"),
    ("viem", "viem", "contracts"),
    ("anchor-lang", "Anchor", "contracts"),
    ("torch", "PyTorch", "ml"),
    ("tensorflow", "TensorFlow", "ml"),
    ("keras", "Keras", "ml"),
    ("scikit-learn", "scikit-learn", "ml"),
    ("sklearn", "scikit-learn", "ml"),
    ("xgboost", "XGBoost", "ml"),
    ("lightgbm", "LightGBM", "ml"),
    ("transformers", "Transformers", "ml"),
    ("pandas", "pandas", "ml"),
    ("numpy", "NumPy", "ml"),
    ("scipy", "SciPy", "ml"),
    ("matplotlib", "matplotlib", "ml"),
    ("seaborn", "seaborn", "ml"),
    ("jupyter", "Jupyter", "ml"),
    ("mlflow", "MLflow", "ml"),
    ("next", "Next.js", "frontend"),
    ("nuxt", "Nuxt", "frontend"),
    ("react-native", "React Native", "mobile"),
    ("react", "React", "frontend"),
    ("vue", "Vue", "frontend"),
    ("svelte", "Svelte", "frontend"),
    ("angular", "Angular", "frontend"),
    ("solid-js", "SolidJS", "frontend"),
    ("tailwindcss", "Tailwind CSS", "frontend"),
    ("wagmi", "wagmi", "frontend"),
    ("redux", "Redux", "frontend"),
    ("express", "Express", "backend"),
    ("fastify", "Fastify", "backend"),
    ("nestjs", "NestJS", "backend"),
    ("koa", "Koa", "backend"),
    ("django", "Django", "backend"),
    ("flask", "Flask", "backend"),
    ("fastapi", "FastAPI", "backend"),
    ("sqlalchemy", "SQLAlchemy", "backend"),
    ("prisma", "Prisma", "backend"),
    ("mongoose", "Mongoose", "backend"),
    ("gin-gonic", "Gin", "backend"),
    ("actix-web", "Actix", "backend"),
    ("rails", "Rails", "backend"),
    ("laravel", "Laravel", "backend"),
    ("spring-boot", "Spring Boot", "backend"),
    ("expo", "Expo", "mobile"),
    ("flutter", "Flutter", "mobile"),
)
"""Dependency names that identify what a project is, and what kind of project.

This is the single highest-signal detection in the whole path, and it is nearly
free: one manifest fetch that was worth making anyway. A repository of `.py`
files could be a Django API, a CLI tool or a classifier — `torch` and
`scikit-learn` in `requirements.txt` settle it in a way no amount of path
inspection can, and the review criteria for those three have almost nothing in
common.

Ordered so the more specific token is tested first: `react-native` before
`react` (otherwise every mobile app detects as a web front end), and
`openzeppelin` before the generic chain libraries."""

MAX_DEPENDENCIES = 8
"""How many library labels the inventory reports. Enough to characterise the
stack; short of reprinting the manifest we already showed the model."""

MAX_INVENTORY_LANGUAGES = 5
"""How many languages the inventory names before the tail stops being
informative. A repository's sixth language is one `.sh` file."""

KIND_NAMES = {
    "contracts": "a smart-contract project",
    "ml": "a machine-learning project",
    "mobile": "a mobile application",
    "fullstack": "a full-stack web application",
    "frontend": "a front-end web application",
    "backend": "a backend service or API",
    "general": "general software",
}
"""`_project_kind`'s labels as a reviewer would say them.

Kept beside the guidance rather than inlined at the two call sites, so the
inventory paragraph and the review criteria can never disagree about what the
project was classified as."""

KIND_GUIDANCE = {
    "contracts": (
        "Weigh access control (who may call what, and is it enforced), value "
        "handling and arithmetic, reentrancy and external-call ordering, and "
        "whether state changes emit events. A contract that merely compiles is "
        "not a contract that is safe to hold funds. Any front end in this "
        "repository is secondary to the contracts themselves."
    ),
    "ml": (
        "Weigh the pipeline, not the accuracy number: how data is loaded and "
        "split, whether the split can leak between train and test, whether the "
        "metric reported suits the task, and whether a run is reproducible "
        "(a fixed seed, pinned dependencies). Training and inference should be "
        "separable. A notebook that reports 0.99 with the test set in the "
        "training data has delivered nothing."
    ),
    "mobile": (
        "Weigh screen and navigation structure, how state survives the "
        "lifecycle, platform permissions actually being requested, and what "
        "the app does with no network. Layout code that only works at one "
        "screen size is incomplete."
    ),
    "fullstack": (
        "Weigh both halves and the boundary between them: whether the client "
        "validates for convenience while the server validates for safety, "
        "whether errors crossing the boundary reach the user as something "
        "actionable, and whether the two agree on the shape of the data."
    ),
    "frontend": (
        "Weigh component structure and reuse, where state lives and whether it "
        "belongs there, loading and error states existing at all, and "
        "accessibility basics — real controls, labels, keyboard reachability. "
        "A screen that only renders the happy path is half-built."
    ),
    "backend": (
        "Weigh request validation at the boundary, error handling and the "
        "status codes actually returned, how persistence is structured, and "
        "whether authentication and authorisation are enforced per route "
        "rather than assumed. Secrets belong in configuration, never in source."
    ),
    "general": (
        "Weigh structure, naming, error handling and whether the code does "
        "what the milestone describes."
    ),
}
"""What to look FOR, by project kind — the type-aware half of the review.

A Solidity contract and a React screen are not well-written in the same way,
and a single rubric applied to both scores whichever one it was written for.
The universal calibration bands stay the same; what changes is which properties
count as evidence of quality.

Deliberately short. This is a lens, not a checklist to be worked through: a
long enumeration invites the model to score the list rather than the code, and
to penalise a milestone for omitting something it was never asked to build."""


def _kind_guidance(kind: str) -> str:
    """The review criteria for a project kind, falling back to the general set.

    Every label `_project_kind` can return has an entry — asserted in the
    offline tests, because a missing one would silently drop the type-aware
    half of the prompt rather than failing."""
    return str(KIND_GUIDANCE.get(kind, KIND_GUIDANCE["general"]))

SIZE_SMALL_MAX = 20
"""At or below this many source files, the whole repository is readable.

The boundary is about what "complete coverage" means, not about cost: under 20
files the reviewer can be shown effectively everything, so an absent feature is
genuinely absent and `completeness` can be judged rather than guessed."""

SIZE_MEDIUM_MAX = 100
"""Above this, no selection is a sample of the project any more — it is a
sample of a part of it, and the prompt must say so."""

PLAN_SMALL = {"files": 18, "budget": 24000, "per_file": 6000, "fetches": 24}
PLAN_MEDIUM = {"files": 12, "budget": 30000, "per_file": 4000, "fetches": 20}
PLAN_LARGE = {"files": 16, "budget": 36000, "per_file": 2600, "fetches": 24}
"""How much of a repository to read, chosen from how big it is.

Three shapes, and the trade between them is depth against breadth:

* **Small** (< 20 source files) — 18 slots at 6000 characters. Essentially
  everything, each file whole. A five-file script or a single contract is read
  in full, so nothing is scored on an excerpt.
* **Medium** (20-100) — 12 slots at 4000. Selection starts to matter, so the
  ranking earns its keep, and the budget rises because there is more genuinely
  relevant code than a small project has.
* **Large** (100+) — 16 slots at 2600, on the largest budget. MORE files, each
  shown SHALLOWER. In a 400-file repository the question stops being "is this
  function well written" and becomes "does this system contain the pieces the
  milestone named", and that is answered by breadth: sixteen file heads across
  the feature directories beat four files read to the end.

`files * per_file` deliberately exceeds `budget` in every plan, so the total
binds first and large files fill fewer slots than the ceiling suggests.

`fetches` bounds the requests spent reaching those slots, including the ones
rejected after the fact as generated output. It is separate from the slot count
because a rejected bundle costs a request and fills nothing."""


def _plan_for(source_count: int) -> dict:
    """The reading plan for a repository of this size.

    Returned as a fresh plain dict rather than one of the module constants:
    the result crosses into a nondet closure and gets cloudpickled, and a
    caller mutating a shared constant would change the plan for every later
    evaluation in the same process.
    """
    if source_count <= SIZE_SMALL_MAX:
        chosen = PLAN_SMALL
        label = "small"
    elif source_count <= SIZE_MEDIUM_MAX:
        chosen = PLAN_MEDIUM
        label = "medium"
    else:
        chosen = PLAN_LARGE
        label = "large"
    return {
        "size": label,
        "files": int(chosen["files"]),
        "budget": int(chosen["budget"]),
        "per_file": int(chosen["per_file"]),
        "fetches": int(chosen["fetches"]),
    }

RELEVANCE_MIN_TOKEN = 5
"""Shortest milestone word allowed to influence ranking.

Four would admit `code`, `with`, `must`, `data` — words in every milestone ever
written, which match nothing distinctive and dilute the real ones. Five keeps
`escrow`, `dispute`, `payroll`, `wallet`."""

RELEVANCE_STOPWORDS = (
    "about", "above", "after", "again", "against", "their", "there", "these",
    "those", "through", "using", "which", "while", "with", "within", "would",
    "should", "must", "shall", "where", "when", "that", "this", "then",
    "public", "private", "build", "built", "building", "create", "created",
    "working", "works", "work", "including", "include", "includes", "included",
    "required", "require", "requires", "requirement", "requirements",
    "milestone", "project", "source", "repository", "repo", "github",
    "deployed", "deploy", "deployment", "complete", "completed", "features",
    "feature", "functional", "functionality", "system", "support", "supports",
)
"""Words common to every milestone description, so matching them ranks nothing.

Sorted-list membership rather than a set: see `_milestone_tokens` on why no
string set may influence this path."""

RELEVANCE_EXTENSION_HINTS = (
    (("solidity", "smart contract", "smart-contract", "erc20", "erc-20",
      "reentrancy", "on-chain", "onchain"), (".sol",)),
    (("frontend", "front-end", "dashboard", "react", "next.js", "nextjs",
      "ui ", "user interface"), (".jsx", ".tsx", ".vue", ".svelte")),
    (("backend", "back-end", "api ", "server", "endpoint"),
     (".go", ".rs", ".java", ".rb", ".php", ".cs")),
)
"""Milestone vocabulary mapped to the extensions that answer it.

Ordered, and the FIRST match wins — a milestone reading "smart contracts …
source in a public GitHub repo" is about Solidity, and accumulating every hint
it brushes against would flatten that back into no preference at all.

The trailing spaces in `"ui "` and `"api "` are load-bearing: without them
`"build"` matches `ui` and every milestone prefers front-end files."""

RELEVANCE_EXTENSION_WEIGHT = 3
"""What a language match is worth against path-token hits.

Above `RELEVANCE_TOKEN_CAP` on purpose. A Solidity milestone should rank a
`.sol` file the milestone never names above a `.jsx` file that happens to be
called `DisputeModal` — the language is the stronger statement of subject."""

RELEVANCE_TOKEN_CAP = 2
"""Most path-token hits one file may bank.

Uncapped, a deeply nested path accumulates hits for every segment and a long
requirements block turns into a directory-depth contest."""

MAX_FILE_BYTES = 120000
"""Skip anything larger before a request is spent on it.

Raised from 50000, which was excluding real deliverables rather than bundles: a
mature Solidity system, a Django `models.py` or a generated-then-hand-edited API
client all run past 50KB, and being dropped from candidacy meant the one file
the milestone was about never reached the reviewer. Per-file character caps
already stop a large file from eating the budget — this ceiling exists only to
avoid spending a request downloading a megabyte to throw away.

`_looks_minified` still rejects vendored bundles after the fetch, which is the
only way to catch the ones that are not named `.min.js`."""

CODE_TEXT_CHARS = 36000
"""The ceiling any plan may spend, and the budget for the non-GitHub path.

Per-repository budgets come from `_plan_for` — this is the maximum of those,
used directly only when the code URL is a forge this contract cannot list
(GitLab, Bitbucket, self-hosted) and the page is rendered instead.

3000 originally, from the old page-render path and unrelated to what a model can
read; then 8000, which was still under a tenth of a real deliverable. Measured on
`cronpay-code/cronpay`: 8000 characters bought 4.7% of four files and 0% of the
277KB of Solidity the milestone was actually about."""

LINE_NUMBER_WIDTH = 4
"""Column width for the line numbers prefixed to every evidence line.

Evidence is numbered so the model's citations can be CHECKED. Asking for line
numbers without supplying them does not produce rigour, it produces confident
fabrication — a reviewer reading "ReentrancyGuard at L142" cannot tell an
observation from an invention unless L142 was in front of the model.

Numbering costs roughly `LINE_NUMBER_WIDTH + 2` characters per line, about 15%
of the budget at typical line lengths. That is the price of citations that can
be falsified, and it is why the budget rose to 20000 in the same change."""

README_CHARS = 800
"""The README states intent, so it earns a slice of the budget — but only a
slice. Letting prose crowd out source is exactly how the old path failed."""

TEMPLATE_README_MARKERS = (
    "this template provides",
    "npm create vite",
    "npx create-next-app",
    "create react app",
    "getting started with create react app",
    "bootstrapped with [create next app]",
    # Heading forms only for the generic stack names. A real README saying
    # "built with React + Vite" in a tech-stack line is describing the project;
    # a README whose FIRST HEADING is that name is the scaffold's own.
    "# react + vite",
    "# react + ts",
    "# vue 3 + vite",
    "# svelte + vite",
    "# nuxt 3 minimal starter",
)
"""Signatures of a README nobody wrote, matched lowercased against the head.

`gm-striker`'s README is `npm create vite`'s verbatim: "# React + Vite / This
template provides a minimal setup…", through to "## Expanding the ESLint
configuration". It is 1027 bytes of prose about Oxc and SWC, and it was the
first 800 characters the model read — a quarter of the whole evidence budget
spent telling the reviewer about a build tool.

Skipping it is not hiding a defect. The requirement it fails ("a README
explaining what the project does") is judged from the absence of one, and the
model is told explicitly that no project README was found. What changes is that
the 800 characters go to source instead of to boilerplate."""

NO_README_NOTE = (
    "// NOTE: this repository has no project README — the only README present is "
    "unmodified framework scaffolding, so it was excluded from the evidence above."
)
"""Stated rather than left as silence, so "no README" reads as a finding about
the repository instead of as a gap in the evidence — the model is asked to judge
documentation and must know which it is looking at.

Placed at the END of the evidence, and that position is load-bearing. The
evidence fingerprint is the first `EVIDENCE_FINGERPRINT_CHARS` of the normalised
text, so leading with 150 characters of fixed prose would make the fingerprint
nearly identical for every repository that has a template README — and the check
that catches a leader swapping in a different repository is exactly that
comparison. A constant prefix hands that away. Trailing it keeps the fingerprint
covering real source.

Its length is reserved out of the budget up front (see `_fetch_github_code`),
because appending to a budget already spent would let the final truncation cut
the note off and silently restore the old silence."""

TEMPLATE_README_SCAN_CHARS = 400
"""How much of the README the markers are tested against.

The head only, deliberately. Scaffold READMEs lead with their signature, while a
genuine README that happens to mention Create React App halfway down — in a
migration note, or crediting where the setup came from — is still somebody's
real documentation and must not be discarded for it."""

SKIP_DIRS = (
    # Dependencies, vendored or installed
    "node_modules", "vendor", "bower_components", "pods",
    "venv", ".venv", "virtualenv", "site-packages",
    ".bundle", ".gradle", ".cargo", "carthage",
    # Build and compile output
    "dist", "build", "target", "out", "obj",
    ".next", ".nuxt", ".svelte-kit", ".output", ".turbo", ".parcel-cache",
    ".angular", ".astro", ".docusaurus", "storybook-static",
    "deriveddata", ".dart_tool",
    # Generated code and chain artefacts
    "artifacts", "typechain", "typechain-types", "generated", "codegen",
    "migrations", ".cache", "forge-cache",
    # Tooling caches and reports
    "coverage", "htmlcov", ".git", "__pycache__", ".mypy_cache",
    ".pytest_cache", ".ruff_cache", ".tox", ".nyc_output", ".idea",
    ".vscode", ".github",
    # ML run output
    "checkpoints", "wandb", "mlruns", ".ipynb_checkpoints",
)
"""Matched per path SEGMENT, never as a substring — a bare `in` test would
also drop `webbuild/app.ts`, which is somebody's actual source.

Grown from twelve entries to cover the shapes this platform now has to accept
from strangers. The originals were a JavaScript reviewer's list; a Python
project buries its source under `.venv`, a Solidity project under `artifacts`
and `typechain-types`, an iOS project under `Pods` and `DerivedData`. Every one
of those directories outweighs the hand-written source around it, so under a
size-first ranking they take every slot and the reviewer is shown generated
output.

Three names were deliberately CONSIDERED and LEFT OUT, because a segment match
is a blunt instrument and each of them names real source at least as often as
it names junk:

* `packages` — the source root of every pnpm/Lerna/Turborepo monorepo. Skipping
  it would delete the entire project on exactly the repository shape this
  change exists to support.
* `data` / `datasets` — `src/data/loader.py` is core ML code. The actual
  datasets are `.csv` and `.pkl`, which are not `SOURCE_EXTENSIONS` and are
  already excluded by extension, so nothing is gained by the directory rule and
  a whole layer is lost to it.
* `bin` — build output for .NET, but the hand-written CLI entry point for a
  published npm package.

`migrations` is the one judgement call kept. Framework migrations are generated
and enormous; a hand-written data migration occasionally is not. Dropping them
costs a rare file and saves a common flood, and a milestone that is genuinely
about a migration will name it — `_named_paths` restores anything the
requirements point at by name, ahead of every other signal."""

SKIP_FILENAMES = (
    "package-lock.json", "yarn.lock", "pnpm-lock.yaml", "cargo.lock",
    "poetry.lock", "go.sum", "composer.lock",
)

SKIP_NAME_MARKERS = (
    # Type declarations carry no implementation to review.
    ".d.ts",
    # Machine-generated: protobuf stubs, codegen output, Dart build artefacts.
    ".pb.", "_pb2.", "_pb2_grpc.", ".g.dart", ".freezed.dart", ".generated.",
    ".designer.", ".min.",
)
"""Filename substrings that disqualify a file before a request is spent on it.

Test markers used to live here, which made "exclude tests" and "exclude
generated code" the same irreversible decision. They are separate concerns:
generated code is never worth reading, while tests are worth reading exactly
when the milestone asked for them — see `TEST_NAME_MARKERS`."""

TEST_NAME_MARKERS = (
    ".test.", ".spec.", "_test.", "test_", ".t.sol",
)
"""Filename substrings that mark a file as a test rather than the deliverable.

Split out of `SKIP_NAME_MARKERS` so pass 4 can go and FETCH these when the
milestone asks for tests, instead of the exclusion being permanent. `.t.sol` is
Foundry's convention and would otherwise read as ordinary Solidity."""

SKIP_TEST_DIRS = (
    "test", "tests", "__tests__", "spec", "specs", "e2e", "cypress",
    "playwright", "fixtures", "mocks", "__mocks__", "testdata",
)
"""Matched per path SEGMENT, like `SKIP_DIRS`."""

CONFIG_FILENAMES = (
    "vite.config", "next.config", "tailwind.config", "postcss.config",
    "eslint.config", "webpack.config", "rollup.config", "babel.config",
    "jest.config", "vitest.config", "metro.config", "svelte.config",
    "nuxt.config", "astro.config", "tsup.config", "commitlint.config",
    "manage.py", "setup.py", "conftest.py", "gatsby-config",
)
"""Build-tool configuration, skipped by FILENAME STEM — never by directory.

This distinction is load-bearing. `src/config/chain.js`, `contract.js` and
`wagmi.js` are the evidence for a requirement that says in as many words "chain
and contract config kept in separate modules". A rule that dropped anything
under a `config/` directory would delete exactly the files the milestone asks
about, while leaving `vite.config.js` — which nobody wrote — in the running."""

FEATURE_DIRS = (
    "components", "component", "pages", "page", "views", "screens",
    "features", "containers", "widgets", "hooks", "controllers",
    "handlers", "services", "models", "routes", "middleware", "store",
)
"""Directory names that hold the code a milestone is actually about.

Files under one of these outrank everything else. The reasoning is empirical:
`src/App.jsx` and `src/main.jsx` are wrappers — an import list and a provider
tree — and they are precisely what a conventional-path probe finds first. The
requirements ("a GM button that connects a wallet and sends the on-chain
transaction", "stats cards showing counts read from the contract") are
implemented one directory down, in `src/components/GMButton.jsx` and
`StatsCards.jsx`, neither of which the old ranking would ever reach."""

ENTRY_FILENAMES = (
    "app", "main", "index", "_app", "server", "mod", "lib",
)
"""Filename stems that are conventionally wrappers, ranked LAST.

Not excluded: in a repository with nothing else they are the only source there
is. Ranked below real modules so they lose the slot whenever something with
implementation in it is available."""

MAX_SOURCE_LINE_CHARS = 500
"""A line longer than this is minifier output, not something a person typed."""

MIN_SOURCE_LINES = 3
"""Fewer lines than this and there is nothing to review."""

TEST_MARKERS = (
    "unit test", "unit-test", "integration test", "end-to-end test",
    "e2e test", "test suite", "test coverage", "test case", "tests for",
    "write tests", "automated test", "testing", "pytest", "jest", "vitest",
    "mocha", "chai", "forge test", "hardhat test", "junit", "rspec",
    "code coverage", "100% coverage",
)
"""Milestone vocabulary that makes test files part of the deliverable.

Tests are skipped from source ranking by default and that is right — they
describe the code rather than being it, and a test file is often the largest
thing in a repository, so under a size-first ranking they would win every slot.

But "must include unit tests with 90% coverage" is a requirement like any
other, and judging it from the absence of test files in an excerpt that
deliberately excluded them is the same failure as scoring `code_quality` off a
repository landing page. When the milestone asks, pass 4 goes and gets them."""

MAX_TEST_FILES = 3
"""Slots reserved for tests when the milestone asks for them.

Enough to show that tests exist, what they cover and how they are written;
short of letting a thorough suite crowd out the implementation it tests. The
inventory reports the true count, so three files plus "27 test files present"
answers "did they write tests" better than seven files would."""

NAMED_PATH_WEIGHT = 8
"""What an explicit mention in the requirements is worth.

Above every other signal combined, and that is the point. If the client wrote
"the escrow logic lives in contracts/Escrow.sol", no heuristic about feature
directories or file size should be able to outvote them — they have told us
exactly which file the milestone is about. This is the one ranking input that
is not an inference."""

NAMED_PATH_EXTENSIONS = (
    ".json", ".toml", ".txt", ".md", ".yml", ".yaml", ".lock", ".cfg", ".ini",
)
"""Non-source extensions that still make a token a filename.

`_named_paths` needs to recognise `package.json` or `hardhat.config.ts` in a
requirements sentence as a FILE REFERENCE, even though neither is a file this
path would ever rank as source. Recognising them costs nothing and missing them
means "must be configured in hardhat.config.ts" reads as three ordinary words."""

MAX_LISTING_RETRIES = 2
"""Extra attempts at the ONE metered listing call, beyond the first.

There is no sleep in this sandbox — `time` is not available and a busy-wait
would burn the leader's budget — so "backoff" here means "try again on the
failures a retry can actually fix, and never on the ones it makes worse":

* **status 0** (connection never completed) and **5xx** are retried. These are
  blips; a second attempt commonly succeeds and costs one request.
* **403 and 429 are NOT retried.** They are GitHub's rate limit, and the only
  thing an immediate retry does to a rate limit is deepen it — three attempts
  spend three times the quota to be refused three times, on shared validator
  egress where that quota is the scarce resource in the first place.

So a quota refusal raises `[TRANSIENT]` on the first response and the caller
retries the whole verification later, when the window has actually moved."""

MIN_EVIDENCE_PCT = 50
"""How much of what was ATTEMPTED must come back before a score is meaningful.

Below this the submission is not scored at all — `_fetch_github_code` raises
and the milestone stays `submitted`. That distinction is the whole point: a low
score REJECTS a milestone and pays nothing, permanently, and doing that because
half the repository would not download punishes the freelancer for a fact about
GitHub. A revert costs a retry.

Measured against files attempted, never against the plan's slot count. The
budget stops the loop early on a repository of large files — four 6000-character
files fill the small plan's 24000 and eighteen slots go unused — and that is the
plan working, not evidence going missing. Counting unfilled slots as failures
would raise "insufficient evidence" on exactly the repositories that gave us the
most to read.

A file that arrives and turns out to be minified counts as attempted and
unread, which is right: a vendored bundle is not reviewable source, and a
repository that is mostly bundles genuinely cannot be judged from its code."""

MAX_TREE_ENTRIES = 40000
"""Ceiling on tree entries walked when ranking.

GitHub truncates its own recursive listing at roughly 100k entries; this cuts
lower so that a monorepo with a checked-in dependency tree cannot turn the rank
into the most expensive part of the evaluation. Entries arrive in a stable
server-side order, so leader and validators walk the same prefix."""


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

    # `/tree/<branch>` pins the branch, and anything deeper is a directory
    # inside it that the client linked ON PURPOSE — it is the milestone's
    # subject, not decoration.
    #
    # That subpath used to be discarded on the reasoning that "the tree call
    # walks the whole repo anyway", which is true and is exactly the bug: all
    # three CronPay milestones pointed at different directories
    # (`/tree/main/contracts`, `/tree/main/Frontend`, the bare root) and every
    # one of them was handed the identical four files, because the whole-repo
    # walk ranked the same three largest frontend files first every time. The
    # contracts milestone — 40 Solidity files, 277KB, judged on
    # "ReentrancyGuard and SafeERC20" — was scored 78 and paid out having
    # never been shown a line of Solidity.
    branch = ""
    subpath = ""
    if len(parts) >= 4 and parts[2] == "tree":
        branch = parts[3]
        # Normalised without leading or trailing slashes so it can be
        # concatenated and prefix-matched without either side guessing.
        subpath = "/".join(parts[4:])

    return {"owner": owner, "repo": repo, "branch": branch, "subpath": subpath}


def _is_template_readme(text: str) -> bool:
    """Whether a README is the scaffold's rather than the project's.

    Whitespace is collapsed before matching so a marker split across a line
    break — "# React + Vite\\n\\nThis template provides…" — still reads as one
    phrase. Matched against the head only; see `TEMPLATE_README_SCAN_CHARS`.
    """
    head = " ".join(str(text)[:TEMPLATE_README_SCAN_CHARS].split()).lower()
    for marker in TEMPLATE_README_MARKERS:
        if marker in head:
            return True
    return False


def _is_test_path(path: str) -> bool:
    """Whether a path is a test rather than the thing being tested.

    Both conventions, because projects use one or the other and rarely both: a
    directory called `tests/`, or a filename carrying `.test.` / `_test.`.
    """
    lowered = path.lower()
    segments = lowered.split("/")
    name = segments[-1]
    for marker in TEST_NAME_MARKERS:
        if marker in name:
            return True
    for directory in segments[:-1]:
        if directory in SKIP_TEST_DIRS:
            return True
    return False


def _is_readable_path(path: str) -> bool:
    """Whether a tree entry is a file worth spending a request on at all.

    Everything `_is_source_path` and `_is_test_source_path` share: a source
    extension, nothing generated, nothing vendored. The test question is asked
    separately by each of them, which is the whole reason this is factored out
    — one predicate answering two different questions is how tests came to be
    unreachable even when the milestone asked for them.
    """
    lowered = path.lower()
    if not lowered.endswith(SOURCE_EXTENSIONS):
        return False

    segments = lowered.split("/")
    name = segments[-1]
    if name in SKIP_FILENAMES:
        return False
    for marker in SKIP_NAME_MARKERS:
        if marker in name:
            return False
    # Config is matched on the stem, so `vite.config.ts` and `vite.config.mjs`
    # both go without also catching `src/config/chain.js` — see
    # `CONFIG_FILENAMES`.
    for stem in CONFIG_FILENAMES:
        if name == stem or name.startswith(stem + "."):
            return False
    for directory in segments[:-1]:
        if directory in SKIP_DIRS:
            return False
    return True


def _is_source_path(path: str) -> bool:
    """Whether a tree entry is implementation worth showing the model."""
    return _is_readable_path(path) and not _is_test_path(path)


def _is_test_source_path(path: str) -> bool:
    """Whether a tree entry is a test worth showing, when tests were asked for."""
    return _is_readable_path(path) and _is_test_path(path)


def _named_paths(text: str) -> list:
    """File and directory names the requirements point at BY NAME.

    A client who writes "the escrow logic lives in `contracts/Escrow.sol`" or
    "extend `src/hooks/usePayroll.ts`" has answered the ranking question
    outright, and no heuristic should be allowed to overrule them. This pulls
    those references out so `_relevance` can weight them above everything else.

    Two shapes are recognised, both conservative:

    * a token containing a dot whose suffix is a known source or metadata
      extension — `Escrow.sol`, `package.json`, `train.py`;
    * a token containing a slash — `contracts/`, `src/hooks/usePayroll.ts` —
      which is a path however it ends.

    Punctuation around the token is stripped, so backticks, quotes, commas and
    a trailing full stop do not prevent a match. Returned SORTED and
    de-duplicated: like `_milestone_tokens`, anything reaching the ranking key
    must be identically ordered on every node.
    """
    lowered = ""
    for char in str(text).lower():
        lowered += char if (char.isalnum() or char in "./_-") else " "

    found = []
    for raw in lowered.split():
        token = raw.strip("./-_")
        if not token or len(token) < 3:
            continue

        # Tested against the UNSTRIPPED token: "everything under contracts/"
        # is a directory reference, and stripping the trailing slash first is
        # what made it read as an ordinary word.
        has_slash = "/" in raw
        has_extension = False
        if "." in token:
            suffix = "." + token.rsplit(".", 1)[1]
            if suffix in SOURCE_EXTENSIONS or suffix in NAMED_PATH_EXTENSIONS:
                has_extension = True

        if not has_slash and not has_extension:
            continue
        if token not in found:
            found.append(token)

    found.sort()
    return found


def _wants_tests(text: str) -> bool:
    """Whether the milestone asks for tests, so pass 4 should go and get them."""
    lowered = " ".join(str(text).lower().split())
    for marker in TEST_MARKERS:
        if marker in lowered:
            return True
    return False


def _manifest_tokens(text: str) -> list:
    """Package names out of a manifest, whatever format it is written in.

    Everything that is not a name character becomes a space, which reduces
    `"next": "16.2.10",` and `scikit-learn==1.3.0` and `torch>=2.0` to the same
    shape without needing to know whether the file was JSON, TOML or a
    requirements list. Version numbers survive as separate tokens and match
    nothing.

    Sorted, for the same determinism reason as everywhere else on this path.
    """
    cleaned = ""
    for char in str(text).lower():
        cleaned += char if (char.isalnum() or char in "-_./@") else " "

    tokens = []
    for token in cleaned.split():
        stripped = token.strip("./-_")
        if stripped and stripped not in tokens:
            tokens.append(stripped)
    tokens.sort()
    return tokens


def _detect_dependencies(manifest_text: str) -> list:
    """Recognised libraries in a manifest, as `[(label, kind), ...]`.

    Ordered by `DEPENDENCY_SIGNALS`, not by appearance in the file, so two
    nodes reading the same manifest report the same list in the same order.
    De-duplicated by LABEL, so `sklearn` and `scikit-learn` do not both appear.
    """
    tokens = _manifest_tokens(manifest_text)

    found = []
    labels = []
    for marker, label, kind in DEPENDENCY_SIGNALS:
        if label in labels:
            continue
        for token in tokens:
            if marker in token:
                found.append((label, kind))
                labels.append(label)
                break
    return found


def _detect_languages(paths: list) -> list:
    """Language histogram over a file list, as `[(language, count), ...]`.

    Sorted by count descending then by name, so ties resolve identically
    everywhere. Counted over the paths that survived the skip rules, which is
    the honest denominator: a repository is not "90% JavaScript" because
    `node_modules` is.
    """
    names = []
    counts = []
    for path in paths:
        lowered = str(path).lower()
        for extension, language in LANGUAGE_BY_EXTENSION:
            if lowered.endswith(extension):
                if language in names:
                    counts[names.index(language)] += 1
                else:
                    names.append(language)
                    counts.append(1)
                break

    pairs = []
    for index in range(len(names)):
        pairs.append((-counts[index], names[index]))
    pairs.sort()

    ranked = []
    for negative_count, language in pairs:
        ranked.append((language, -negative_count))
    return ranked


def _detect_frameworks(paths: list) -> list:
    """Toolchain labels implied by configuration files present in the tree.

    Free: it reads the listing this function was given and makes no request.
    """
    found = []
    for marker, label in FRAMEWORK_SIGNALS:
        if label in found:
            continue
        for path in paths:
            name = str(path).lower().split("/")[-1]
            if name.startswith(marker) or name == marker:
                found.append(label)
                break
        if len(found) >= MAX_FRAMEWORKS:
            break
    return found


def _project_kind(languages: list, dependencies: list, framework_labels: list) -> str:
    """What KIND of project this is, which decides how it should be reviewed.

    Returned as one of a fixed set of labels; `_kind_guidance` turns it into
    the review criteria the prompt carries. Rules are evaluated in a fixed
    order over already-sorted inputs, so it is deterministic.

    The order encodes which signal is the stronger statement of subject. A
    repository with Solidity in it and React around it is a smart-contract
    project with a front end — the contracts hold the money, and a reviewer who
    treats them as an implementation detail of the dashboard is reviewing the
    wrong thing. Dependencies outrank file counts for the same reason: four
    `.py` files that import `torch` are a model, and forty that import `django`
    are an API, and the extension says neither.
    """
    kinds = []
    for _label, kind in dependencies:
        if kind not in kinds:
            kinds.append(kind)

    top_language = languages[0][0] if languages else ""
    chain_languages = ("Solidity", "Vyper", "Cairo", "Move")

    has_notebooks = False
    for language, _count in languages:
        if language == "Jupyter notebook":
            has_notebooks = True
            break

    if top_language in chain_languages or "contracts" in kinds:
        # Only when the chain code is actually present. A front end that talks
        # to somebody else's deployed contract pulls in `ethers` and is not a
        # contract project.
        for language, _count in languages:
            if language in chain_languages:
                return "contracts"
        if "Hardhat" in framework_labels or "Foundry" in framework_labels:
            return "contracts"

    if "ml" in kinds or has_notebooks:
        return "ml"
    if "mobile" in kinds or "Flutter" in framework_labels:
        return "mobile"
    if "frontend" in kinds and "backend" in kinds:
        return "fullstack"
    if "frontend" in kinds:
        return "frontend"
    if "backend" in kinds:
        return "backend"
    return "general"


def _file_role(path: str) -> str:
    """A short, honest label for what a file is, inferred from its path.

    Deliberately structural — "UI component", "configuration module" — and never
    functional. The tempting version of this reads `GMButton.jsx` and captions it
    "wallet connect + on-chain transaction", which is a guess presented to the
    model as a fact; if the file turned out to be an empty stub, the caption
    would be arguing the freelancer's case for them. What a path genuinely
    proves is where the author filed it.
    """
    lowered = path.lower()
    segments = lowered.split("/")
    name = segments[-1]
    stem = name.rsplit(".", 1)[0]
    parents = segments[:-1]

    if name.startswith("readme"):
        return "project README"
    for directory in parents:
        if directory in ("components", "component", "widgets"):
            return "UI component"
        if directory in ("pages", "page", "views", "screens", "routes"):
            return "page or route"
        if directory == "hooks":
            return "reusable hook"
        if directory in ("config", "configs", "settings"):
            return "configuration module"
        if directory in ("services", "api", "handlers", "controllers"):
            return "service or request handler"
        if directory in ("models", "schemas", "entities"):
            return "data model"
        if directory in ("utils", "helpers", "lib"):
            return "utility module"
        if directory in ("styles", "css"):
            return "stylesheet"
    if lowered.endswith(".css"):
        return "stylesheet"
    if lowered.endswith(".sol"):
        return "smart contract"
    if stem in ENTRY_FILENAMES:
        return "application entry point"
    return "source file"


def _milestone_tokens(text: str) -> list:
    """
    Distinctive words from the milestone, for matching against file paths.

    Returned as a SORTED LIST, never a set. Python hashes strings with a
    per-process random seed, so iterating a set of strings yields a different
    order on the leader than on a validator — and any ordering that reaches the
    ranking key would make two honest nodes select different files and
    fingerprint different evidence. Every collection on this path is ordered
    explicitly for that reason.
    """
    lowered = ""
    for char in str(text).lower():
        lowered += char if (char.isalnum() or char == "-") else " "

    seen = []
    for word in lowered.split():
        if len(word) < RELEVANCE_MIN_TOKEN or word in RELEVANCE_STOPWORDS:
            continue
        if word not in seen:
            seen.append(word)
    seen.sort()
    return seen


def _evidence_focus(milestone_desc: str, requirements: str) -> str:
    """
    The text that steers which files get read: the MILESTONE description alone.

    The project-wide `requirements` are deliberately excluded despite being
    available. They describe every milestone at once — CronPay's list runs from
    "Solidity smart contracts" to "React dashboard" — so folding them in gives
    each milestone the union of all of them and ranks by nothing in particular.
    The milestone description is the only text that states what THIS submission
    was supposed to deliver.

    It is a named helper rather than an inline expression because the leader and
    every validator must derive the identical string; two spellings of the same
    idea in two places is precisely the drift that shows up as a false
    fingerprint mismatch. `requirements` stays in the signature so the exclusion
    is visible at the call site instead of looking like an oversight.
    """
    return str(milestone_desc)


def _preferred_extensions(text: str) -> tuple:
    """Extensions the milestone's own wording asks for.

    A milestone naming Solidity or smart contracts wants `.sol`; one naming a
    dashboard or React wants the front-end extensions. Checked in a fixed order
    and returning the FIRST match rather than accumulating, so a milestone that
    mentions both ("contracts deployed … source in a public repo") resolves to
    the subject rather than to everything.
    """
    lowered = str(text).lower()
    for keywords, extensions in RELEVANCE_EXTENSION_HINTS:
        for keyword in keywords:
            if keyword in lowered:
                return extensions
    return ()


def _relevance(path: str, tokens: list, extensions: tuple, named: list = []) -> int:
    """How well a path answers the milestone, 0 upwards. Higher ranks first.

    Three independent signals, deliberately coarse — this decides *ordering*,
    not a score, and a finely-tuned number here would be a second scoring system
    nobody can audit.
    """
    lowered = path.lower()
    score = 0

    # The client named this file or directory outright. Worth more than every
    # inference combined, and counted ONCE however many references match: a
    # requirements block that says `contracts/Escrow.sol` three times has stated
    # one fact, and letting it stack would rank by how often a client repeated
    # themselves.
    for reference in named:
        if reference in lowered:
            score += NAMED_PATH_WEIGHT
            break

    # The milestone named a language or layer, and this file is it.
    if extensions and lowered.endswith(extensions):
        score += RELEVANCE_EXTENSION_WEIGHT

    # A word from the milestone appears in the path — `dispute`, `escrow`,
    # `payroll`. Capped so a long requirements block cannot let one deep path
    # outrank the language match itself.
    hits = 0
    for token in tokens:
        if token in lowered:
            hits += 1
            if hits >= RELEVANCE_TOKEN_CAP:
                break
    return score + hits


def _rank_source_files(entries: list, tokens: list = [], extensions: tuple = (),
                       subpath: str = "", named: list = [],
                       tests: bool = False) -> list:
    """
    The source files worth showing, best first.

    Ordered by a total, deterministic key so the leader and every validator pick
    the same files from the same tree:

        (-relevance, tier, -size, path)

    `relevance` is how well the path answers THIS milestone — the language it
    named, and its own vocabulary appearing in the path. It leads because size
    and tier are proxies for "probably important" while relevance is evidence
    about the actual question. With no keywords supplied it is 0 for every
    candidate and the key degrades exactly to the previous `(tier, -size, path)`.

    `tier` puts real modules ahead of wrappers — feature directories first, then
    files whose name is PascalCase (a component by convention even when it sits
    outside one), then anything else, then conventional entry points last.
    `-size` then prefers the larger file within a tier, on the assumption that
    bytes are roughly where the logic is. `path` breaks remaining ties, and is
    what makes the sort reproducible rather than merely stable: two validators
    sorting the same tree must produce the same list, not just a consistent one.

    `subpath` restricts candidates to the directory the client linked. Without
    it, a `/tree/main/contracts` URL still walked the whole repository and the
    largest files anywhere won — which is how a Solidity milestone was judged on
    three React pages. See `_parse_github_repo`.

    `named` carries the paths the requirements pointed at BY NAME, which
    `_relevance` weights above every inference — see `NAMED_PATH_WEIGHT`.

    `tests` switches the candidate filter from implementation to test files, so
    pass 4 can rank tests by the same key rather than by a second copy of this
    logic. Tests are otherwise excluded, and that default is right: they
    describe the code rather than being it, and they are often the largest
    files in a repository.

    Ranking on size alone was never wrong so much as blind: it asks "what is the
    biggest file here", when the question is "what did this milestone promise".
    """
    prefix = f"{subpath}/" if subpath else ""

    candidates = []
    for entry in entries:
        if not isinstance(entry, dict):
            continue
        if str(entry.get("type", "")) != "blob":
            continue

        path = str(entry.get("path", ""))
        if not path:
            continue
        if tests:
            if not _is_test_source_path(path):
                continue
        elif not _is_source_path(path):
            continue
        if prefix and not path.startswith(prefix):
            continue

        try:
            size = int(entry.get("size", 0))
        except Exception:
            continue
        if size > MAX_FILE_BYTES:
            continue

        segments = path.split("/")
        name = segments[-1]
        stem = name.rsplit(".", 1)[0]
        lowered_parents = [segment.lower() for segment in segments[:-1]]

        if any(directory in FEATURE_DIRS for directory in lowered_parents):
            tier = 0
        elif stem.lower() in ENTRY_FILENAMES:
            # Tested BEFORE the PascalCase rule, or `src/App.jsx` — the single
            # most common wrapper there is — reads as a component on the strength
            # of its capital A and takes a slot from real implementation.
            tier = 3
        elif stem[:1].isupper():
            tier = 1
        else:
            tier = 2

        candidates.append(
            (-_relevance(path, tokens, extensions, named), tier, -size, path)
        )

    candidates.sort()

    ranked = []
    for _relevance_rank, _tier, _negative_size, path in candidates:
        ranked.append(path)
    return ranked


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


def _find_readme(paths: list, subpath: str = "") -> str:
    """Path of the shallowest README, or "" when the repo has none.

    Under a linked subdirectory that directory's own README is preferred —
    `contracts/` documents the contracts — and the repository root README is
    the fallback, because that is where a monorepo states what the project as a
    whole is for, which is what `requirements` are judged against.
    """
    prefix = f"{subpath}/" if subpath else ""
    scopes = (prefix, "") if prefix else ("",)

    for scope in scopes:
        best = ""
        best_depth = -1
        for path in paths:
            if scope and not path.startswith(scope):
                continue
            if not path.lower().split("/")[-1].startswith("readme"):
                continue

            depth = path.count("/")
            if best_depth == -1 or depth < best_depth or (
                depth == best_depth and path < best
            ):
                best = path
                best_depth = depth

        if best:
            return best
    return ""


def _find_manifests(paths: list, subpath: str = "") -> list:
    """Dependency manifests in this tree, most-informative first.

    Ordered by `MANIFEST_FILENAMES` rather than by where they sit, so a
    repository holding both `package.json` and `requirements.txt` reports them
    in the same order on every node. Within one filename the SHALLOWEST copy
    wins, and under a linked subdirectory that subdirectory is searched first —
    a `/tree/main/Frontend` submission is built from `Frontend/package.json`,
    and the root manifest of a monorepo would describe somebody else's half.

    Returns at most `MAX_MANIFESTS` paths.
    """
    prefix = f"{subpath}/" if subpath else ""
    # Scoped then whole-repo, so the subdirectory's own manifest is preferred
    # without excluding a root-only one. Unscoped, the single "" sweep already
    # covers the tree — running a second identical pass would only cost time.
    scopes = (prefix, "") if prefix else ("",)

    found = []
    for filename in MANIFEST_FILENAMES:
        if len(found) >= MAX_MANIFESTS:
            break

        for scope in scopes:
            best = ""
            best_depth = -1
            for path in paths:
                if scope and not path.startswith(scope):
                    continue
                if path.lower().split("/")[-1] != filename:
                    continue
                depth = path.count("/")
                if best_depth == -1 or depth < best_depth or (
                    depth == best_depth and path < best
                ):
                    best = path
                    best_depth = depth

            if best and best not in found:
                found.append(best)
                break

    return found


def _inventory_line(
    total_files: int,
    source_paths: list,
    test_count: int,
    languages: list,
    frameworks: list,
    dependencies: list,
    kind: str,
    shown: int,
) -> str:
    """What the repository IS, in one paragraph, ahead of the excerpt from it.

    This is the difference between a reviewer who knows they are holding 12 of
    78 source files in a Hardhat project and one who assumes the five files in
    front of them are the whole deliverable. The second reviewer scores
    `completeness` off an accident of ranking — which is exactly what produced
    a 0/0/0/0 on a repository that met its milestone.

    Every number here comes from the tree listing both sides fetched, so it is
    the same paragraph on the leader and on every validator.
    """
    parts = []

    language_bits = []
    for language, count in languages[:MAX_INVENTORY_LANGUAGES]:
        language_bits.append(f"{count} {language}")
    if language_bits:
        parts.append(
            f"{total_files} files, {len(source_paths)} of them source "
            f"({', '.join(language_bits)})."
        )
    else:
        parts.append(f"{total_files} files, {len(source_paths)} of them source.")

    if frameworks:
        parts.append(f"Toolchain: {', '.join(frameworks)}.")

    labels = []
    for label, _kind in dependencies[:MAX_DEPENDENCIES]:
        labels.append(label)
    if labels:
        parts.append(f"Declared dependencies: {', '.join(labels)}.")

    if test_count:
        parts.append(f"{test_count} test files present.")
    else:
        parts.append("No test files found anywhere in the tree.")

    parts.append(f"Reviewed as: {KIND_NAMES.get(kind, 'general software')}.")

    # Stated last and stated plainly, because it is the single fact most likely
    # to be assumed wrongly: an excerpt reads as a whole repository unless it
    # says otherwise.
    if shown >= len(source_paths):
        parts.append(f"All {shown} source files are shown below, in full.")
    else:
        parts.append(
            f"{shown} of the {len(source_paths)} source files are shown below, "
            f"selected as most relevant to THIS milestone — the rest exist and "
            f"were not read."
        )

    return " ".join(parts)


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


def _list_repo_tree(owner: str, name: str, ref: str, pinned: str = "") -> list:
    """
    The repository's complete file listing — the inventory everything else reads.

    ONE metered call. `api.github.com` allows 60 requests per hour per IP while
    `raw.githubusercontent.com` is unmetered, so this single request is the
    entire quota cost of evaluating a submission, on the leader and on each
    validator alike.

    Retried only where a retry can help. Status 0 (the connection never
    completed) and 5xx are blips that a second attempt commonly clears; 403 and
    429 are the rate limit itself, and retrying a rate limit spends more quota
    to be refused again — see `MAX_LISTING_RETRIES`. So a quota refusal raises
    `[TRANSIENT]` immediately and the caller retries the whole verification
    later, when the window has moved.

    Raises rather than returning empty. A listing that cannot be read is not a
    repository with no files in it, and scoring the difference as though it were
    is how a freelancer gets rejected for GitHub being busy.
    """
    attempt = 0
    while True:
        result = _web_get(
            f"https://api.github.com/repos/{owner}/{name}"
            f"/git/trees/{ref}?recursive=1",
            GITHUB_HEADERS,
        )
        status = int(result["status"])
        if status == 200:
            break

        if attempt < MAX_LISTING_RETRIES and (status == 0 or status >= 500):
            attempt += 1
            continue

        if _is_transient_status(status):
            raise gl.vm.UserError(
                f"{ERROR_TRANSIENT} GitHub returned {status} listing "
                f"{owner}/{name}. Verify again."
            )
        # A pinned branch that does not exist is the one case where naming a
        # branch is the actual diagnosis. Unpinned, `HEAD` resolved whatever the
        # default is, so advice to "check the branch is main or master" would
        # send the client after a problem they do not have. Both sides build
        # this message from the URL alone, which matters: `_compare_user_errors`
        # matches `[EXTERNAL]` exactly.
        raise gl.vm.UserError(
            f"{ERROR_EXTERNAL} Could not list {owner}/{name} — GitHub returned "
            f"{status}. Check the repository is public"
            + (f" and that branch `{pinned}` exists." if pinned else ".")
        )

    try:
        parsed = json.loads(result["body"])
    except Exception:
        parsed = None

    if not isinstance(parsed, dict) or not isinstance(parsed.get("tree"), list):
        raise gl.vm.UserError(
            f"{ERROR_EXTERNAL} GitHub's file listing for {owner}/{name} could "
            f"not be read."
        )

    return parsed["tree"][:MAX_TREE_ENTRIES]


def _fetch_github_code(github_url: str, focus: str = "") -> dict:
    """
    Real source out of a GitHub repository, in the quantity that repository
    warrants.

    Four passes, in this order:

    0. **Inventory** — one metered listing call. Everything below is decided
       from it: how large the repository is, what languages are in it, what
       toolchain it declares, and therefore how much of it to read.
    1. **Context** — the README and up to `MAX_MANIFESTS` dependency manifests.
       A manifest is where a project states what it is BUILT FROM, and "must use
       OpenZeppelin" is checkable in one line of it and not checkable at all
       from a ranked sample of source files.
    2. **Implementation** — the files `_rank_source_files` puts first, up to the
       plan's slot count.
    3. **Tests** — only when the milestone asked for them (`_wants_tests`).

    The size plan is the point of the ordering. `_plan_for` reads the source
    count off the inventory and returns 18 slots at 6000 characters for a small
    repository (effectively all of it, each file whole), 12 at 4000 for a medium
    one, and 16 at 2600 for a large one — more files each shallower, because in
    a 400-file system the question stops being "is this function well written"
    and becomes "does this contain the pieces the milestone named", which is
    answered by breadth.

    The listing runs FIRST rather than as a fallback behind conventional-path
    probes. Probing by convention spent up to six sequential round trips
    guessing names the listing simply states, and it is what filled both of the
    old two slots with `src/App.jsx` and `src/main.jsx` — an import list and a
    provider tree — on a repository whose every requirement lived one directory
    down. The quota cost is unchanged, because the listing was already
    unconditional.

    Fails CLOSED throughout. This runs on the leader AND on every validator: if
    one side reached the API and another was rate-limited into rendering the
    landing page instead, the two would fingerprint entirely different content
    and the validator would reject honest evidence — reading as a dishonest
    leader rather than as the network problem it is. So a transient failure
    raises `[TRANSIENT]`, which `_compare_user_errors` treats as agreement when
    both sides hit one, and the whole verification reverts cleanly for the
    caller to retry. A 404 is different: every validator sees it identically, so
    it raises `[EXTERNAL]`, which must match exactly and does.

    Returns the evidence together with what it took to gather — the inventory
    paragraph, the project kind, and how many of the planned slots were actually
    filled, which is what `_gather_evidence` judges sufficiency from.
    """
    repo = _parse_github_repo(github_url)
    if not repo:
        return {"text": "", "inventory": "", "kind": "", "planned": 0,
                "attempted": 0, "read": 0}

    # What this milestone is about, in its own words. Derived here rather than
    # passed in pre-computed so the leader and every validator run the SAME
    # derivation over the SAME string — see `_milestone_tokens` on ordering.
    tokens = _milestone_tokens(focus)
    extensions = _preferred_extensions(focus)
    named = _named_paths(focus)

    owner = str(repo["owner"])
    name = str(repo["repo"])
    pinned = str(repo["branch"])
    subpath = str(repo.get("subpath", ""))

    # A `/tree/<branch>/` URL pins the branch the client actually linked; with
    # nothing pinned, `HEAD` resolves the repository's real default. Either way
    # there is exactly ONE ref, settled before the first request and never
    # revised by what a fetch happened to return — see `GITHUB_DEFAULT_REF`.
    ref = pinned if pinned else GITHUB_DEFAULT_REF

    def _raw(path: str) -> str:
        """One file from raw.githubusercontent.com, whole.

        Raises on transient, returns "" on a plain 404. Untruncated so the
        caller can judge it before the budget cuts it down — see
        `_looks_minified`. Unmetered, unlike the listing.
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

    # ── Pass 0: the inventory ─────────────────────────────────────────────────
    tree = _list_repo_tree(owner, name, ref, pinned)

    prefix = f"{subpath}/" if subpath else ""
    repo_paths = []
    scoped_paths = []
    source_paths = []
    test_paths = []
    for entry in tree:
        if not isinstance(entry, dict):
            continue
        if str(entry.get("type", "")) != "blob":
            continue
        path = str(entry.get("path", ""))
        if not path:
            continue

        repo_paths.append(path)
        if prefix and not path.startswith(prefix):
            continue
        scoped_paths.append(path)

        # `_is_source_path` is readable-and-not-a-test, `_is_test_source_path`
        # is readable-and-a-test, so the `elif` splits readable files cleanly
        # and everything unreadable falls out of both counts.
        if _is_source_path(path):
            source_paths.append(path)
        elif _is_test_source_path(path):
            test_paths.append(path)

    if not scoped_paths:
        raise gl.vm.UserError(
            f"{ERROR_EXTERNAL} {owner}/{name} contains no files"
            + (f" under `{subpath}`." if subpath else ".")
        )

    plan = _plan_for(len(source_paths))
    languages = _detect_languages(source_paths)
    # Frameworks are read from the WHOLE tree rather than the linked
    # subdirectory: a `/tree/main/contracts` submission is still built by the
    # `hardhat.config.ts` in the repository root, and that is the fact worth
    # reporting about it.
    frameworks = _detect_frameworks(repo_paths)

    slots = int(plan["files"])
    per_file = int(plan["per_file"])
    fetch_cap = int(plan["fetches"])
    budget = int(plan["budget"])
    if budget > CODE_TEXT_CHARS:
        budget = CODE_TEXT_CHARS

    pieces = []
    used = 0
    accepted = 0
    fetches = 0
    have_readme = False
    template_readme = False
    fetched_paths = []

    def _add(path: str, body: str, room: int, limit: int) -> int:
        """One file as a labelled chunk, returned as the characters it consumed.

        The header carries the file's real length and a structural role, so the
        model can tell a 300-character stub from a 4000-character implementation
        it is only being shown part of. Truncation is announced for the same
        reason: the old format cut a file mid-token with no marker, and an
        excerpt that looks like a whole file reads as an unfinished one.

        `body` is always the WHOLE file so the reported length is the real one;
        `limit` is this file's slice of the budget, and comes from the size plan
        rather than from a constant — the same 4000-character file is shown
        whole in a small repository and truncated in a large one.

        Lines are numbered from 1, and because the excerpt is always the file's
        HEAD the numbers are the file's real ones — a citation to L142 can be
        opened in the repository and checked. Truncating from the head rather
        than from anywhere more clever is what preserves that property.
        """
        shown = body[:limit]
        cut = f" — showing first {len(shown)}" if len(shown) < len(body) else ""
        header = f"// FILE: {path} ({len(body)} chars, {_file_role(path)}{cut})"

        numbered = []
        line_no = 0
        for line in shown.split("\n"):
            line_no += 1
            numbered.append(f"{str(line_no).rjust(LINE_NUMBER_WIDTH)}| {line}")

        chunk = f"{header}\n" + "\n".join(numbered)
        chunk = chunk[:room]
        pieces.append(chunk)
        fetched_paths.append(path)
        return len(chunk)

    # ── Pass 1: context — the README, then the manifests ──────────────────────
    readme_path = _find_readme(repo_paths, subpath)
    if readme_path:
        body = _raw(readme_path)
        if body:
            if _is_template_readme(body):
                # Scaffold boilerplate. Skipped rather than truncated into the
                # evidence, which is what spent a quarter of the old budget on
                # `npm create vite`'s notes about Oxc and SWC — see
                # `TEMPLATE_README_MARKERS`. The room for the note that replaces
                # it is reserved out of the budget here, not deducted later.
                template_readme = True
                fetched_paths.append(readme_path)
                budget = budget - len(NO_README_NOTE) - 2
            else:
                used += _add(readme_path, body, budget - used, README_CHARS)
                have_readme = True

    manifest_text = ""
    for path in _find_manifests(repo_paths, subpath):
        room = budget - used
        if room <= 0:
            break
        body = _raw(path)
        if not body:
            continue

        # Kept WHOLE for detection and truncated only for display. The token
        # that identifies the project — `torch`, `openzeppelin` — can sit past
        # the display cap in a manifest with 200 transitive pins, and reading it
        # costs nothing once the file has been fetched.
        manifest_text += "\n" + body
        used += _add(path, body, room, MANIFEST_CHARS)

    dependencies = _detect_dependencies(manifest_text)
    kind = _project_kind(languages, dependencies, frameworks)

    # ── Pass 2: implementation, ranked against this milestone ─────────────────
    ranked = _rank_source_files(tree, tokens, extensions, subpath, named)
    planned = slots if slots < len(ranked) else len(ranked)
    attempted = 0

    for path in ranked:
        if accepted >= slots or fetches >= fetch_cap:
            break
        room = budget - used
        if room <= 0:
            break
        # Already in `pieces` as context; fetching again would buy a duplicate
        # with a source slot.
        if path in fetched_paths:
            continue

        fetches += 1
        attempted += 1
        body = _raw(path)
        if not body or _looks_minified(body):
            continue

        used += _add(path, body, room, per_file)
        accepted += 1

    # ── Pass 3: tests, only when the milestone asked for them ─────────────────
    #
    # Excluded by default and that default is right — a test file is often the
    # largest thing in a repository and would win slots from the code it tests.
    # But "must include unit tests with 90% coverage" is a requirement like any
    # other, and judging it from an excerpt that deliberately excluded tests is
    # the same failure as scoring code_quality off a repository landing page.
    if test_paths and _wants_tests(focus):
        taken = 0
        for path in _rank_source_files(
            tree, tokens, extensions, subpath, named, True
        ):
            if taken >= MAX_TEST_FILES or fetches >= fetch_cap:
                break
            room = budget - used
            if room <= 0:
                break
            if path in fetched_paths:
                continue

            fetches += 1
            body = _raw(path)
            if not body or _looks_minified(body):
                continue

            used += _add(path, body, room, per_file)
            taken += 1

    # ── Fail closed on evidence, not on a score ───────────────────────────────
    #
    # Deliberately NOT a low score. A rejected milestone pays nothing and cannot
    # be appealed from inside the contract, so "we could not read the code" and
    # "the code is bad" must not arrive at the same place. This reverts: the
    # milestone stays `submitted`, and a freelancer who makes the repository
    # public — or a caller who retries once GitHub is willing — gets a real
    # verdict.
    #
    # Both branches are deterministic and identical on every node: the counts
    # come from the same tree and the same fetches, and `_compare_user_errors`
    # matches `[EXTERNAL]` exactly.
    if accepted == 0:
        # Checked BEFORE the note is attached, or a repository whose only
        # readable file was a scaffold README would return the note as its
        # evidence: a non-empty `code_text` holding no code at all, which
        # `_gather_evidence` waves through and the model is then asked to score.
        # Job 16 was rejected at 45 on exactly that — a README scored as code.
        raise gl.vm.UserError(
            f"{ERROR_EXTERNAL} No source code could be read from {owner}/{name} "
            f"({len(source_paths)} source files listed, {attempted} attempted). "
            f"Check the repository is public"
            + (f" and that branch `{pinned}` exists." if pinned else ".")
        )

    if accepted * 100 < attempted * MIN_EVIDENCE_PCT:
        raise gl.vm.UserError(
            f"{ERROR_EXTERNAL} Insufficient evidence from {owner}/{name}: only "
            f"{accepted} of {attempted} source files could be read. The "
            f"milestone was NOT scored — this is not a judgement on the work. "
            f"Check the files are present and readable, then verify again."
        )

    text = "\n\n".join(pieces)[:budget]

    if template_readme and not have_readme:
        # Attached AFTER truncation, against the room reserved out of `budget`
        # when the template was detected. Appending before the cut left the note
        # to be shaved by the separators that `used` never counted — the tail of
        # the sentence disappeared and the absence went unstated again.
        text = text + "\n\n" + NO_README_NOTE

    return {
        "text": text,
        "inventory": _inventory_line(
            len(scoped_paths),
            source_paths,
            len(test_paths),
            languages,
            frameworks,
            dependencies,
            kind,
            accepted,
        ),
        "kind": kind,
        "planned": planned,
        "attempted": attempted,
        "read": accepted,
    }


def _gather_evidence(github_url: str, site_url: str, focus: str = "") -> dict:
    """
    Fetch the text evidence. No LLM — this is the half a validator can afford.

    Screenshots are not fetched here and not fingerprinted: they are bytes that
    differ between any two renders, so they cannot be compared, and they exist
    only to feed the design-match prompt.

    `focus` is the milestone text that steers file ranking. It is part of what
    the evidence IS, not a presentation detail: two nodes passing different
    focus strings would select different files, fingerprint different content,
    and the validator would read an honest leader as a liar. Both call sites
    therefore pass the same value, built the same way — see `verify_milestone`.
    """
    code_text = ""
    site_text = ""
    inventory = ""
    kind = ""
    planned = 0
    attempted = 0
    read = 0
    if github_url:
        # The two paths are chosen by the URL alone, never by whether a fetch
        # succeeded. That is what keeps the leader and every validator on the
        # SAME path for the same submission: a fallback triggered by failure
        # would put a rate-limited validator on `render` while the leader used
        # the API, and the resulting fingerprint mismatch would look like a
        # lying leader instead of a busy network.
        if _parse_github_repo(github_url):
            fetched = _fetch_github_code(github_url, focus)
            code_text = str(fetched["text"])
            inventory = str(fetched["inventory"])
            kind = str(fetched["kind"])
            planned = int(fetched["planned"])
            attempted = int(fetched["attempted"])
            read = int(fetched["read"])
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
        # What the repository IS, alongside an excerpt OF it. Carried separately
        # rather than prepended to `code_text` because the fingerprint is the
        # HEAD of the evidence: a paragraph of inventory in front of it would
        # make every repository with the same stack fingerprint alike and hand
        # away the swap check that is the validator's whole job.
        "inventory": inventory,
        "kind": kind,
        "planned": planned,
        "attempted": attempted,
        "read": read,
        "code_len": len(_normalize(code_text)),
        "site_len": len(_normalize(site_text)),
        "code_fp": _fingerprint(code_text),
        "site_fp": _fingerprint(site_text),
        # Fingerprinted in its own right so a leader cannot bias the review by
        # describing a repository it did not read — the counts and the project
        # kind come off the tree listing every validator fetches too.
        "inv_fp": _fingerprint(inventory),
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
    ev = _gather_evidence(github_url, site_url, _evidence_focus(milestone_desc, requirements))

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
        str(ev["inventory"]),
        str(ev["kind"]),
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
    scores["inv_fp"] = str(ev["inv_fp"])
    scores["kind"] = str(ev["kind"])
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
    # The inventory steers the review — how much of the repository the excerpt
    # is, and which criteria `_kind_guidance` supplies — so it is part of the
    # evidence, not a presentation detail. Both sides derive it from the same
    # tree listing, so it compares exactly rather than within a tolerance.
    if str(leader_scores.get("inv_fp", "")) != str(own_evidence["inv_fp"]):
        return False
    if str(leader_scores.get("kind", "")) != str(own_evidence["kind"]):
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
                reasoning="",
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

        # Plain str, computed once, captured by the validator closure below —
        # it is cloudpickled to reach every node, and it must be byte-identical
        # to what `_gather_and_score` derives on the leader or the two select
        # different files and fingerprint different evidence.
        focus = _evidence_focus(milestone_desc, requirements)

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
                _gather_evidence(code_url, live_url, focus)
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
            own_evidence = _gather_evidence(code_url, live_url, focus)
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
        # `scores` came through consensus, but this key rode along unvalidated
        # by design — see `_extract_scores`. Re-cut the length here rather than
        # trusting the value: the block's output is only as bounded as whatever
        # the leader put in it.
        ms.reasoning = str(scores.get("reasoning", ""))[:REASONING_CHARS]

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
                # The reviewer's own account of what it read, with file and line
                # citations. Present so a reader can OPEN the cited lines and
                # check them — it is the leader's claim, not a verified fact.
                "reasoning": ms.reasoning,
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
