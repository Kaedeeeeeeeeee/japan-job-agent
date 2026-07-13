# ADR-015: Canonical source table is the sole primary truth

当前主来源只由 `canonical_job_sources` 表示，并由部分唯一索引保证一个 active primary。Canonical Job 不保存第二份 primary 外键；Materialization 输入同样只允许一个 primary。

