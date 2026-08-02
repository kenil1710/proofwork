# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
from genlayer import *
import json


# Throwaway diagnostic, not part of the protocol. It answers one question that
# cannot be answered from outside GenVM: what does `gl.nondet.web.render` return
# for a client-rendered single-page app?
#
# It matters because `verify_milestone` scores `functionality` from
# `render(site_url, mode="text")`. If that call returns only the static shell,
# then every SPA — which is most modern front-end work — is judged on an empty
# string, and the prompt's own instruction ("score 0 for an axis with no
# evidence") makes 0 the correct answer. `gritual-striker.vercel.app` serves an
# 849-byte `index.html` whose body is `<div id="root"></div>`; an off-chain fetch
# sees 22 characters of `<title>`. Whether GenVM sees more is what this measures.
#
# Line 1 must stay the runner pin: a comment above it makes the contract
# undeployable, and the only error reported is `invalid_contract`.


def _probe_modes(url: str) -> dict:
    """Render one URL every way the runtime offers, and report shape not content.

    Lengths and heads only. The full page would be megabytes through consensus,
    and the question here is whether JavaScript ran — which a length answers.
    """
    out = {}
    for mode in ("text", "html"):
        try:
            rendered = str(gl.nondet.web.render(url, mode=mode))
            out[mode + "_len"] = len(rendered)
            out[mode + "_head"] = rendered[:600]
        except Exception as error:
            # Recorded rather than raised: "this mode is unsupported" is itself
            # the finding, and one failing mode must not lose the other's result.
            out[mode + "_len"] = -1
            out[mode + "_head"] = "ERROR: " + str(error)[:300]
    return out


class RenderProbe(gl.Contract):
    result: str

    def __init__(self):
        self.result = ""

    @gl.public.write
    def probe(self, url: str) -> None:
        def leader_fn() -> dict:
            return _probe_modes(url)

        def validator_fn(leader_result: gl.vm.Result) -> bool:
            # An isinstance check and nothing more. A validator that renders the
            # page too would disagree on every byte of a live site, and a
            # validator that called an LLM would stop the transaction committing
            # at all — measured, and the reason ProofWork's own validators only
            # check evidence integrity.
            return isinstance(leader_result, gl.vm.Return)

        self.result = json.dumps(gl.vm.run_nondet(leader_fn, validator_fn))

    @gl.public.view
    def get_result(self) -> str:
        return self.result
