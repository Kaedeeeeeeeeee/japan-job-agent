# ADR-009: Temporal coordinates durable workflows

Temporal 用于可重试的同步、解析和 materialization 编排。Activity 必须可幂等重放，数据库写入仍是最终事实；细节见 ADR-018。

