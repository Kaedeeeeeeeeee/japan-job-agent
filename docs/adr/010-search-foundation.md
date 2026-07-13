# ADR-010: Structured search before embeddings

第一阶段使用结构化过滤、规范化技能、精确/前缀匹配和 `pg_trgm`。保留 pgvector Schema，但不生成 Embedding，也不用于硬过滤。

