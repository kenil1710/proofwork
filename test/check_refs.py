#!/usr/bin/env python3
"""
Static name-resolution check for contracts/proof_work.py.

`genvm-lint validate` does NOT resolve names — it reported "✓ Validation passed"
on a contract whose `verify_milestone` called `self._parse_score(...)` after that
method had been deleted. That only surfaced on chain as a LEADER_TIMEOUT, after
a deploy and a full end-to-end run.

Run this before every deploy.

Usage: python3 test/check_refs.py [path]
"""
import ast
import sys
from pathlib import Path

path = Path(sys.argv[1] if len(sys.argv) > 1 else "contracts/proof_work.py")
tree = ast.parse(path.read_text())

module_fns = {n.name for n in tree.body if isinstance(n, ast.FunctionDef)}
module_classes = {n.name for n in tree.body if isinstance(n, ast.ClassDef)}
contracts = [
    n for n in tree.body
    if isinstance(n, ast.ClassDef)
    and any(
        (isinstance(b, ast.Attribute) and b.attr == "Contract")
        or (isinstance(b, ast.Name) and b.id == "Contract")
        for b in n.bases
    )
]

problems = []

for contract in contracts:
    methods = {n.name for n in contract.body if isinstance(n, ast.FunctionDef)}
    fields = {
        n.target.id for n in contract.body
        if isinstance(n, ast.AnnAssign) and isinstance(n.target, ast.Name)
    }

    for node in ast.walk(contract):
        if (
            isinstance(node, ast.Attribute)
            and isinstance(node.value, ast.Name)
            and node.value.id == "self"
            and node.attr not in fields
            and node.attr not in methods
        ):
            problems.append(
                f"{path}:{node.lineno}: self.{node.attr} is neither a storage "
                f"field nor a method of {contract.name}"
            )

known = module_fns | module_classes
for node in ast.walk(tree):
    if (
        isinstance(node, ast.Call)
        and isinstance(node.func, ast.Name)
        and node.func.id.startswith("_")
        and node.func.id not in known
    ):
        problems.append(f"{path}:{node.lineno}: {node.func.id}() is not defined")

if problems:
    print("\n".join(sorted(set(problems))))
    print(f"\n{len(set(problems))} unresolved reference(s)")
    sys.exit(1)

print(f"✓ all self.* and _helper references resolve in {path}")
