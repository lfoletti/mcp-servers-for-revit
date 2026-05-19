"""_run_claude.py — robust claude -p spawn on Windows.

Node's spawn with shell:true mangles multi-line prompts via cmd.exe.
Python's subprocess (argv list, no shell) reliably handles claude.cmd
+ multi-line strings — pattern proven by run_live.py.

Usage: pipe prompt on stdin.
  python _run_claude.py <cwd> <max_turns> <timeout_s>
Stdout = claude's --output-format json output. Exit code = claude's.
"""
import sys, json, subprocess

cwd = sys.argv[1]
max_turns = int(sys.argv[2])
timeout = int(sys.argv[3])
prompt = sys.stdin.read()

cmd = ["claude", "-p", prompt,
       "--output-format", "json",
       "--max-turns", str(max_turns),
       "--allowedTools", "mcp__revit"]
try:
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True,
                       encoding="utf-8", errors="replace", timeout=timeout)
    sys.stdout.write(r.stdout)
    if r.stderr:
        sys.stderr.write(r.stderr)
    sys.exit(r.returncode)
except subprocess.TimeoutExpired:
    print(json.dumps({"is_error": True, "_timeout": True, "wall_s": timeout}))
    sys.exit(124)
except FileNotFoundError as e:
    print(json.dumps({"is_error": True, "_no_claude": True, "msg": str(e)}))
    sys.exit(127)
