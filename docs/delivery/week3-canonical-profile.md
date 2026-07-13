# Week 3 delivery: Canonical, deduplication, real Profile

Date: 2026-07-13

## Delivered

- normalized application URL deduplication with tracking removal but semantic query preservation
- same-company posting/requisition identity merge and reviewed official-link merge entrypoint
- title equality explicitly excluded from automatic merge
- Canonical materialization from Extraction IDs, source priority, one primary, source conflicts, Evidence links and immutable versions
- manual unmerge with merge history, primary repair and rematerialization of both resulting Canonical Jobs
- allowlist-only local resume extraction and versioned Profile with a database constraint forbidding direct PII
- deterministic hard eligibility and matched/gap/unknown evaluation served at `/agent/jobs`

## Real Profile

- 2027 new graduate and junior midcareer channels
- Product/Web/AI engineering primary, iOS secondary, Unity/game supplementary
- Tokyo metro and Japan-remote
- permanent preferred; fixed-term needs confirmation; dispatch, SES on-site, independent contractor and part-time excluded
- Japanese JLPT N1, Chinese native, English TOEIC 680
- visa informational only; annual JPY 4,000,000 is a soft target; unknown salary remains eligible
- 14 allowlisted resume skills and 4 experience groups detected; no name, contact, address, URL or resume prose stored

## Verified behavior

- 145 real verified active Extractions materialized to 145 Canonical Jobs
- all 145 have exactly one active primary, a current version and current Evidence
- repeat materialization created 0 versions and reused 145
- repeat Profile import reused Profile v1
- `/agent/jobs`: 145 eligible, 145 visa-unknown warnings, 139 jobs with at least one evidence-backed match

