"""Measure the multiplier and redraw the charts in docs/.

    python3 docs/measure.py

Uses only the standard library. Prints the table from how-the-multiplier-works.md,
writes docs/distribution.svg (300,000 rounds of the current formula against 0.99/t)
and docs/edge.svg (the exact house edge per target, first version and current).
"""

import hashlib
import math
import statistics
from pathlib import Path

E = 2 ** 52
ROUNDS = 300_000
HERE = Path(__file__).parent


def top52(seed: str, client: str, nonce: int) -> int:
    return int(hashlib.sha256(f"{seed}:{client}:{nonce}".encode()).hexdigest(), 16) >> 204


def current(h: int) -> int:
    """The contract's formula: floor(0.99 / (1 - u)) in hundredths, at least 1.00x."""
    return max(99 * E // (E - h), 100)


def first_version(h: int) -> int:
    h = h or 1
    return max((100 * E - h) // (E - h), 100)


def edge(formula: str, target: int) -> float:
    """Exact house edge of a bet on target (x100), counted over all 2^52 values of h."""
    if formula == "current":
        wins = 99 * E // target                      # h >= E - 99E/target
    else:
        wins = E - -(-E * (target - 100) // (target - 1))   # h >= ceil(E(T-100)/(T-1))
    return 1 - target / 100 * wins / E


def log_x(t: float) -> float:
    return 64 + (656 - 64) * math.log(t) / math.log(100)


def frame(title: str, y_ticks: list[tuple[float, str]], y) -> list[str]:
    out = [
        '<svg xmlns="http://www.w3.org/2000/svg" width="680" height="420" viewBox="0 0 680 420" font-family="ui-monospace,Consolas,monospace">',
        '<rect width="680" height="420" fill="#0a1017" rx="12"/>',
        f'<text x="64" y="18" fill="#e2ebf2" font-size="13" font-weight="700">{title}</text>',
    ]
    for value, label in y_ticks:
        out.append(f'<line x1="64" y1="{y(value):.1f}" x2="656" y2="{y(value):.1f}" stroke="#152230" stroke-width="1"/>')
        out.append(f'<text x="56" y="{y(value) + 3:.1f}" fill="#6a7e91" font-size="10" text-anchor="end">{label}</text>')
    for t in (1, 2, 3, 5, 10, 20, 50, 100):
        out.append(f'<line x1="{log_x(t):.1f}" y1="28" x2="{log_x(t):.1f}" y2="368" stroke="#101a24" stroke-width="1"/>')
        out.append(f'<text x="{log_x(t):.1f}" y="384" fill="#6a7e91" font-size="10" text-anchor="middle">{t}×</text>')
    out.append('<text x="360.0" y="412" fill="#6a7e91" font-size="11" text-anchor="middle">cash-out target t</text>')
    return out


def main() -> None:
    xs = [current(top52("measure-seed", "client", n)) for n in range(ROUNDS)]
    print(f"{ROUNDS:,} rounds of the current formula")
    print(f"instant 1.00x: {sum(x == 100 for x in xs) / ROUNDS:.2%}   median: {statistics.median(xs) / 100:.2f}x")
    print("| target | measured | 0.99/t |")
    targets = (1.01, 1.5, 2, 3, 5, 10, 50, 100)
    measured = {}
    for t in targets:
        share = sum(x >= round(t * 100) for x in xs) / ROUNDS
        measured[t] = share
        print(f"| {t}x | {share:.2%} | {0.99 / t:.2%} |")
    print("| target | edge, first version | edge, current |")
    for t in targets:
        print(f"| {t}x | {edge('first', round(t * 100)):.2%} | {edge('current', round(t * 100)):.2%} |")

    # P(crash >= t) on log-log axes, 1% to 100%.
    def y_share(p: float) -> float:
        return 28 + (368 - 28) * (math.log(1) - math.log(p)) / (math.log(1) - math.log(0.0099))

    svg = frame("P(crash ≥ t): 300k rounds vs 0.99/t", [(1, "100%"), (0.5, "50%"), (0.2, "20%"), (0.1, "10%"), (0.05, "5%"), (0.02, "2%"), (0.01, "1%")], y_share)
    line = " ".join(f"{log_x(t):.1f},{y_share(0.99 / t):.1f}" for t in (1.01 * (100 / 1.01) ** (i / 120) for i in range(121)))
    svg.append(f'<polyline points="{line}" fill="none" stroke="#48d3e6" stroke-width="2"/>')
    for t in targets:
        svg.append(f'<circle cx="{log_x(t):.1f}" cy="{y_share(measured[t]):.1f}" r="4.5" fill="#f2a413" stroke="#0a1017" stroke-width="1.5"/>')
    svg += [
        '<line x1="430" y1="44" x2="452" y2="44" stroke="#48d3e6" stroke-width="2"/>',
        '<text x="458" y="48" fill="#8aa0b4" font-size="11">theory 0.99/t</text>',
        '<circle cx="441" cy="62" r="4.5" fill="#f2a413"/>',
        '<text x="458" y="66" fill="#8aa0b4" font-size="11">measured (contract formula)</text>',
        "</svg>",
    ]
    (HERE / "distribution.svg").write_text("\n".join(svg) + "\n")

    # Exact house edge per target, 0% to 1.2%.
    def y_edge(e: float) -> float:
        return 368 - (368 - 28) * e / 0.012

    svg = frame("House edge by cash-out target, exact", [(0.012, "1.2%"), (0.01, "1.0%"), (0.008, "0.8%"), (0.006, "0.6%"), (0.004, "0.4%"), (0.002, "0.2%"), (0, "0%")], y_edge)
    steps = [round(101 * (10000 / 101) ** (i / 160)) for i in range(161)]
    for formula, colour in (("first", "#f2a413"), ("current", "#48d3e6")):
        points = " ".join(f"{log_x(t / 100):.1f},{y_edge(edge(formula, t)):.1f}" for t in steps)
        svg.append(f'<polyline points="{points}" fill="none" stroke="{colour}" stroke-width="2"/>')
    svg += [
        '<line x1="340" y1="300" x2="362" y2="300" stroke="#48d3e6" stroke-width="2"/>',
        '<text x="368" y="304" fill="#8aa0b4" font-size="11">current: 0.99 / (1 − u)</text>',
        '<line x1="340" y1="320" x2="362" y2="320" stroke="#f2a413" stroke-width="2"/>',
        '<text x="368" y="324" fill="#8aa0b4" font-size="11">first version: (1 − u/100) / (1 − u)</text>',
        "</svg>",
    ]
    (HERE / "edge.svg").write_text("\n".join(svg) + "\n")


if __name__ == "__main__":
    main()
