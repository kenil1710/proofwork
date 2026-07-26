# { "Depends": "py-genlayer:1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6" }
"""
Probe v2 — what exactly can a nondet lambda close over?

Probe v1 disproved "capturing self is the fault": a lambda calling a method on
self succeeded. But v1 captured `str(self.note)` — an explicit conversion to a
real Python str. `verify_milestone` captures `job_mem.requirements` raw, straight
off a copy_to_memory'd @allow_storage dataclass.

So the suspect is now the VALUE, not self: if those attributes are still
storage-backed proxies rather than plain str, pickling them to set up the nondet
block is what raises "Detected pickling storage class".

Mirrors ProofWork's exact storage shape: TreeMap of an @allow_storage dataclass.
Three methods, differing only in what the closure captures.
"""
from genlayer import *
from dataclasses import dataclass


@allow_storage
@dataclass
class Thing:
    text: str
    n: u32


def _use(text) -> str:
    # str() here happens INSIDE the block, after pickling — so it cannot mask a
    # capture-time failure.
    return gl.nondet.exec_prompt(f"Reply with only the digit 7. Context: {str(text)[:100]}")


class Probe2(gl.Contract):
    things: TreeMap[u32, Thing]
    note: str
    last: str

    def __init__(self):
        self.note = "probe"
        self.last = ""
        self.things[u32(0)] = Thing(text="hello world", n=u32(1))

    @gl.public.write
    def raw_plain_field(self) -> None:
        """Captures a plain storage str attribute, no str() conversion."""
        t = self.note
        result = gl.eq_principle.prompt_non_comparative(
            lambda: _use(t), task="Echo a digit", criteria="Any single digit."
        )
        self.last = "raw_plain:" + str(result)

    @gl.public.write
    def copied_dataclass_raw(self) -> None:
        """Exactly what verify_milestone does: copy_to_memory, capture raw."""
        thing = self.things[u32(0)]
        mem = gl.storage.copy_to_memory(thing)
        t = mem.text
        result = gl.eq_principle.prompt_non_comparative(
            lambda: _use(t), task="Echo a digit", criteria="Any single digit."
        )
        self.last = "copied_raw:" + str(result)

    @gl.public.write
    def copied_dataclass_str(self) -> None:
        """Same, but forced to a real str before capture."""
        thing = self.things[u32(0)]
        mem = gl.storage.copy_to_memory(thing)
        t = str(mem.text)
        result = gl.eq_principle.prompt_non_comparative(
            lambda: _use(t), task="Echo a digit", criteria="Any single digit."
        )
        self.last = "copied_str:" + str(result)

    @gl.public.view
    def get_last(self) -> str:
        return self.last
