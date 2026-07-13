# 10,000-job source expansion design

## Outcome

Maintain roughly 10,000 active Japan jobs whose current application page is an official company page or a verified ATS relationship. The corpus covers all lawful employment sectors, including Specified Skilled Worker routes, while discovery and review prioritize IT, e-commerce, IT consulting, and HR operations.

The target is an active corpus, not a historical row count. A job is recommendation-eligible only after the existing raw-version, extraction, evidence, lifecycle, and Canonical pipeline succeeds.

## Trust boundary

Discovery sources such as JETRO OFP and foreign-employment event lists identify companies worth auditing. They never prove that a current job accepts foreign applicants. Signals remain separate:

1. `job_explicit`: the current job text explicitly states visa, overseas-application, nationality, or language acceptance.
2. `company_explicit`: an official or attributable company-level source states foreign-talent hiring interest or support.
3. `unknown`: no supported statement exists. Unknown must not become rejection.

Company-level signals may inform risk text and source-audit priority but cannot be copied into job-level facts.

## Data flow

1. A versioned Discovery Source produces an immutable import run.
2. The run upserts Company Discovery Candidates by source and external key.
3. Candidate facts retain source URL, quote, fetch time, and raw hash.
4. The audit queue verifies legal entity, official domain, recruiting link, and ATS tenant.
5. A verified relationship creates or links the normal Company and Source Instance.
6. ATS synchronization continues through Finalized Snapshot, Raw Version, Extraction, Evidence, lifecycle, and Canonical materialization.

Discovery failures never close jobs. Removing a company from a discovery list only expires that discovery assertion.

## Coverage priority

The first 1,000 active jobs target about 60% from P0/P1 categories, without imposing a permanent quota:

- P0: software, web, product, AI, data, e-commerce.
- P1: IT consulting, implementation, technical support, digital transformation, HR, recruiting, people operations, and labor administration.
- P2: manufacturing, trade, logistics, accommodation, retail, and general roles.
- P3: Specified Skilled Worker routes and other lawful sector-specific channels.

Priority controls discovery and review order. It does not override evidence-backed personal matching or experience gaps.

## Connector sequence

1. HRMOS collection connector.
2. HERP Careers.
3. Talentio.
4. Workday, SmartRecruiters, and Lever after policy review.
5. Sitemap plus schema.org and reviewed generic official-career adapters.

Collection connectors must retrieve complete record bodies before an authoritative snapshot is finalized. CI uses fixtures; live audits are scheduled separately and rate-limited per host.

## Milestone acceptance

- JETRO OFP imports are idempotent and preserve provenance without contact-person PII.
- Discovery candidates cannot enter recommendations directly.
- Company-level foreign-hiring signals cannot masquerade as job-level evidence.
- HRMOS collection total, job identities, exact detail bodies, and official application URLs are replayable.
- An interrupted HRMOS detail fetch produces a partial snapshot.
- Empty or sharply reduced collections use the existing closure circuit breaker.
- Coverage reports separate active jobs, historical jobs, verified relationships, industries, priorities, signal levels, and unknown rates.

