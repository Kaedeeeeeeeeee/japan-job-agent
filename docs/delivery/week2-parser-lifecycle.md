# Week 2 delivery: parser, evidence, schema.org, lifecycle

Date: 2026-07-13

## Delivered

- deterministic JSON/HTML parser for employment, visa sponsorship, location/remote, language, skills, and compensation
- independent Parser replay from immutable object storage with versioned Extraction rows
- transactional Evidence and specialized-field persistence; non-unknown values fail if no evidence exists
- schema.org `JobPosting` single-record connector with HTTPS, DNS/private-address, redirect, credential and response-size controls
- persistent ACTIVE/SUSPECT/CLOSED lifecycle with authoritative-only absence, minimum interval, recovery timeline and explicit single-record closure
- nightly live audit and real single-record sync for kubell and NEWONE

## Verified live results

- kubell: official `career.kubell.com` link, active 2027 Web Engineer JobPosting, Raw + Extraction succeeded
- NEWONE: official `new-one.co.jp` link, active 27卒/第二新卒 Engineer JobPosting, Raw + Extraction succeeded
- Parser 1.1 corrected an initial false part-time match from company headcount text; the current Extraction is permanent only and records JPY 333,000 monthly base pay
- 145 Greenhouse Raw Versions replayed: 145 succeeded, 0 failed, 574 Evidence rows
- every non-unknown high-risk field had evidence; unknown rates remain separately visible

## Safety behavior

- partial/failed collection syncs do not increase missing counters
- two authoritative misses must be at least the configured interval apart
- HTTP 410 can close only the matching existing single record
- 403/429/5xx/schema failures end or degrade the Source without closing jobs

