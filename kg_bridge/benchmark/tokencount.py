#!/usr/bin/env python3
"""tokencount.py — layered, self-reporting token counter.

Backends, in priority order (each run reports which one produced the numbers,
so the benchmark never misrepresents its figures):

  1. anthropic_count_tokens  -- EXACT Claude tokens via the Anthropic
     `messages.count_tokens` endpoint. Requires ANTHROPIC_API_KEY. This is a
     counting call, NOT a generation: no model output is produced, so it does
     not incur generation spend. This is the recommended way to get exact
     absolute numbers.
  2. tiktoken                -- cl100k_base BPE. Not Claude's tokenizer, but a
     stable, reproducible proxy. Because both architectures are counted with
     the *same* tokenizer, the architecture-to-architecture *ratio* is robust
     to the tokenizer choice even when absolute counts drift.
  3. heuristic               -- structural estimator for JSON/identifier-heavy
     text. Clearly labelled as an estimate.

The benchmark headline metrics (round-trip / sequential-completion counts) are
exact integers and tokenizer-independent; token figures refine, not carry, the
argument.
"""
from __future__ import annotations

import os
import re
from typing import Tuple

_ANTHROPIC_MODEL = os.environ.get("KG_BENCH_MODEL", "claude-sonnet-4-6")


def _try_anthropic(text: str) -> int | None:
    if not os.environ.get("ANTHROPIC_API_KEY"):
        return None
    try:
        import anthropic  # type: ignore

        client = anthropic.Anthropic()
        resp = client.messages.count_tokens(
            model=_ANTHROPIC_MODEL,
            messages=[{"role": "user", "content": text}],
        )
        return int(resp.input_tokens)
    except Exception:
        return None


def _try_tiktoken(text: str) -> int | None:
    try:
        import tiktoken  # type: ignore

        enc = tiktoken.get_encoding("cl100k_base")
        return len(enc.encode(text))
    except Exception:
        return None


_WORD = re.compile(r"[A-Za-z]+|\d+|\s+|[^\sA-Za-z\d]")


def _heuristic(text: str) -> int:
    """Structural BPE proxy. JSON payloads are punctuation-dense (every brace,
    quote, colon, comma tends to be its own token) and contain long
    identifiers (split into sub-word pieces). Empirically this lands within
    ~10-15% of BPE for such text — good enough for a *ratio*, labelled as an
    estimate for absolutes."""
    tokens = 0
    for m in _WORD.finditer(text):
        s = m.group()
        if s.isspace():
            continue
        if s.isalpha() or s.isdigit():
            # ~1 token per 4 chars for alpha runs, min 1.
            tokens += max(1, (len(s) + 3) // 4)
        else:
            # punctuation: one token per char (conservative for JSON).
            tokens += len(s)
    return tokens


def count(text: str) -> Tuple[int, str]:
    """Return (token_count, method_name)."""
    n = _try_anthropic(text)
    if n is not None:
        return n, "anthropic_count_tokens(exact)"
    n = _try_tiktoken(text)
    if n is not None:
        return n, "tiktoken_cl100k(proxy)"
    return _heuristic(text), "heuristic(estimate)"


if __name__ == "__main__":
    import sys

    sample = sys.stdin.read() or '{"hello":"world","n":[1,2,3]}'
    c, method = count(sample)
    print("{} tokens via {}".format(c, method))
