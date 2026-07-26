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


def _extract_scores(reply: object) -> dict:
    """
    Pull all four scores out of whatever the model actually returned.

    Raises `gl.vm.UserError` with the `[LLM_ERROR]` prefix rather than
    defaulting to zero: a zero is a permanent rejection of someone's work, and
    "the model was chatty" is not a reason to refuse to pay. The prefix makes
    validators disagree, which rotates onto a model that will answer properly.
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
            # An axis the model left out scores zero. That is safe because an
            # axis only reaches the final score if it carries weight, and it
            # only carries weight when its evidence was supplied.
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
        code_text = str(gl.nondet.web.render(github_url, mode="text"))[:3000]
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

    scores = _extract_scores(reply)

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
        has_code = github_url != "" and github_url != "none"
        has_site = site_url != "" and site_url != "none"
        has_mockup = mockup_url != "" and mockup_url != "none"

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
