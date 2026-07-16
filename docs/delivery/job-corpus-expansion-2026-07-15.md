# Job corpus expansion audit — 2026-07-15

The verified corpus contains 2056 active Canonical Jobs. With the real PII-free primary Profile and deterministic hard filters, 665 are recommendation-eligible and 1391 are explicitly excluded.

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
| talentio | 67 | 1314 |
| smartrecruiters | 1 | 98 |

## Eligible jobs by source

| Source kind | Eligible jobs |
|---|---:|
| talentio | 390 |
| greenhouse | 102 |
| smartrecruiters | 81 |
| hrmos | 57 |
| engage | 16 |
| herp | 10 |
| airwork | 9 |

Parser 1.8.3 succeeded for 2072 current Raw Versions. All 4483 non-unknown high-risk facts have evidence; missing evidence: 0.

Global Greenhouse boards are retained as complete authoritative snapshots. Explicit non-Japan locations are deterministically hard-rejected; unknown locations remain visible as unknown, consistent with the product policy.
