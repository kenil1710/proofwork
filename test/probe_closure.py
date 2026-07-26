# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
"""
Isolates one variable: does a nondet lambda that closes over `self` fail?

`verify_milestone` reverted with `kind<VmError` and stderr "Detected pickling
storage class. Reading storage in nondet mode is not supported", at run_time 0s
with no eq_outputs — i.e. it died setting up the nondet block, before any LLM or
web call. The only storage-backed object its lambda captures is `self`.

Two methods, identical except for that one thing:
  run_method_closure   -> lambda calls self._inside(...)   [captures self]
  run_function_closure -> lambda calls _outside(...)       [captures only a str]

Both read the same storage field into a local first, so storage access outside
the block is held constant.
"""
from genlayer import *


def _outside(text: str) -> str:
    """Module-level: nothing storage-backed is reachable from here."""
    return gl.nondet.exec_prompt(f"Reply with only the digit 7. Context: {text}")


class Probe(gl.Contract):
    note: str
    last: str

    def __init__(self):
        self.note = "probe"
        self.last = ""

    def _inside(self, text: str) -> str:
        """Method: reaching it goes through `self`."""
        return gl.nondet.exec_prompt(f"Reply with only the digit 7. Context: {text}")

    @gl.public.write
    def run_method_closure(self) -> None:
        note = str(self.note)
        result = gl.eq_principle.prompt_non_comparative(
            lambda: self._inside(note),
            task="Echo a digit",
            criteria="Any single digit is acceptable.",
        )
        self.last = "method:" + str(result)

    @gl.public.write
    def run_function_closure(self) -> None:
        note = str(self.note)
        result = gl.eq_principle.prompt_non_comparative(
            lambda: _outside(note),
            task="Echo a digit",
            criteria="Any single digit is acceptable.",
        )
        self.last = "function:" + str(result)

    @gl.public.view
    def get_last(self) -> str:
        return self.last
