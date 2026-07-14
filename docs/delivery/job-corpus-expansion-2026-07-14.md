# Job corpus expansion audit — 2026-07-14

The verified corpus contains 660 active Canonical Jobs. With the real PII-free primary Profile and deterministic hard filters, 457 are recommendation-eligible and 203 are explicitly excluded.

## Verified active sources

| Source kind | Sources | Active jobs |
|---|---:|---:|
| greenhouse | 7 | 390 |
| schema_org | 1 | 1 |
| hrmos | 3 | 89 |
| herp | 4 | 43 |
| jobcan | 1 | 5 |
| airwork | 10 | 60 |
| engage | 10 | 56 |
| talentio | 2 | 16 |

## Eligible jobs by source

| Source kind | Eligible jobs |
|---|---:|
| greenhouse | 222 |
| hrmos | 81 |
| airwork | 60 |
| engage | 44 |
| herp | 30 |
| talentio | 14 |
| jobcan | 5 |
| schema_org | 1 |

Parser 1.6.0 succeeded for 660 current Raw Versions. All 1021 non-unknown high-risk facts have evidence; missing evidence: 0.

Global Greenhouse boards are retained as complete authoritative snapshots. Explicit non-Japan locations are deterministically hard-rejected; unknown locations remain visible as unknown, consistent with the product policy.
