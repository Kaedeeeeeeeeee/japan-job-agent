# ADR-019: LLM 只提出证据候选，Embedding 只负责召回

Status: Accepted

## Decision

LLM 只能为仍为 unknown 的字段提出候选，并必须同时返回当前 Raw Version 内的 Section ID 与逐字 Quote。程序验证引用、执行确定性 Normalizer 后，候选才能成为 Evidence 和结构化事实。LLM 不覆盖 known，不证明“原文未提及”，也不决定职位真伪、生命周期、准入、硬过滤或最终排名。

Embedding 只在同一职位的 Section 检索和跨职位候选召回中使用。跨职位召回固定在同一 Model Key 与维度内，结果必须再次经过确定性准入和排名。Saved/Applied 不受语义召回集合限制。

## Consequences

- 模型不可用时，抓取、确定性解析、准入、排名和模板解释仍可运行。
- 所有 AI 事实和解释都能回到已有 Evidence ID。
- 更换模型会生成新的 Embedding/任务版本，不会静默改变旧 Recommendation Run。

