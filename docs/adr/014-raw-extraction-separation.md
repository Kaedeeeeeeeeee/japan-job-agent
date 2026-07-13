# ADR-014: Raw and Extraction versions are separate

Raw Version 只保存不可变原文和抓取元数据。Extraction 以 `(raw version, parser key, parser version, schema version)` 唯一。Parser 重放新增 Extraction，不更新 Raw。

