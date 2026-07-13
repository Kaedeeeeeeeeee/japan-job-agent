# ADR-002: Raw versions are immutable

抓取到的原文字节不可覆盖。相同 Record 与 `raw_hash` 幂等复用；任何解析修正不得修改原文。本 ADR 的存储边界由 ADR-014 进一步收紧。

