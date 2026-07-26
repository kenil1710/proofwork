# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }

# The blank line above is load-bearing. GenVM parses the *contiguous* leading
# `#` block as the runner JSON — that is how multi-line "Seq" headers work — so
# a comment on the very next line gets concatenated into the JSON and the whole
# thing fails to parse. The deploy then comes back ACCEPTED but
# FINISHED_WITH_ERROR / invalid_contract, with no hint that a comment caused it.
#
# Diagnostic probe — NOT production code, do not copy this pattern.
#
# verify_milestone's evaluator is proven correct (the leader returns real scores
# in eqBlocksOutputs) but the transaction never commits: validators commit and
# never reveal, and it dies at APPEAL_COMMITTING / IDLE.
#
# Two candidate causes, and they call for opposite fixes:
#
#   A. The validator is too expensive. The restructure moved from
#      prompt_non_comparative (validators judge the leader's output) to
#      run_nondet with a validator that REruns the whole evaluation — so every
#      validator now does its own web render + LLM prompt.
#   B. Bradbury simply cannot settle a heavy nondet transaction right now,
#      whatever the validator does.
#
# These three methods differ ONLY in validator cost, over identical leader work.
# Whichever settle tells us which cause is real:
#
#   no_llm      web render only, cheap validator   — does ANY nondet tx settle?
#   no_rerun    render + LLM, cheap validator      — is the LLM the problem?
#   with_rerun  render + LLM, validator reruns     — is MY validator the problem?
#
# `no_rerun` is deliberately the leader-output-only anti-pattern. It is a
# control, not a proposal.

from genlayer import *


def _fetch(url: str) -> str:
    return str(gl.nondet.web.render(url, mode="text"))[:500]


def _fetch_and_score(url: str) -> dict:
    text = str(gl.nondet.web.render(url, mode="text"))[:1000]
    reply = gl.nondet.exec_prompt(
        "Rate how complete this web page is, 0-100. Respond ONLY with JSON, "
        'no prose: {"score": <integer 0-100>}\n\nPAGE:\n' + text,
        response_format="json",
    )
    raw = 0
    if isinstance(reply, dict):
        for key in ("score", "rating", "value"):
            if key in reply:
                try:
                    raw = int(round(float(str(reply[key]).strip())))
                except Exception:
                    raw = 0
                break
    return {"score": max(0, min(100, raw))}


class ConsensusProbe(gl.Contract):
    # u32, not a bare top-level `str`. A `str` storage field is the one thing
    # this probe had that proof_work.py does not, and the first deploy died
    # with `invalid_contract` — the same error memory records for a `u256`
    # field. Storing a number sidesteps the question entirely; the result we
    # actually care about is readable from the transaction either way.
    runs: u32

    def __init__(self):
        self.runs = u32(0)

    @gl.public.write
    def no_llm(self, url: str) -> None:
        """Web render only, trivial validator. Baseline: does nondet work at all?"""

        def leader_fn() -> dict:
            return {"len": len(_fetch(url))}

        def validator_fn(res: gl.vm.Result) -> bool:
            return isinstance(res, gl.vm.Return)

        out = gl.vm.run_nondet(leader_fn, validator_fn)
        self.runs = u32(self.runs + u32(1))

    @gl.public.write
    def no_rerun(self, url: str) -> None:
        """Render + LLM, but the validator does NOT rerun. Isolates validator cost."""

        def leader_fn() -> dict:
            return _fetch_and_score(url)

        def validator_fn(res: gl.vm.Result) -> bool:
            return isinstance(res, gl.vm.Return)

        out = gl.vm.run_nondet(leader_fn, validator_fn)
        self.runs = u32(self.runs + u32(1))

    @gl.public.write
    def with_rerun(self, url: str) -> None:
        """Render + LLM, validator reruns and compares — what verify_milestone does."""

        def leader_fn() -> dict:
            return _fetch_and_score(url)

        def validator_fn(res: gl.vm.Result) -> bool:
            if not isinstance(res, gl.vm.Return):
                return False
            own = leader_fn()
            return abs(int(res.calldata.get("score", 0)) - int(own["score"])) <= 10

        out = gl.vm.run_nondet(leader_fn, validator_fn)
        self.runs = u32(self.runs + u32(1))

    @gl.public.view
    def get_runs(self) -> u32:
        return self.runs
