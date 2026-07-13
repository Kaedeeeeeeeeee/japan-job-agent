# ADR-016: Orchestrator finalizes snapshots

只有 Orchestrator 看见全部分页、Schema/租户/总数校验结果和关闭熔断状态，因此只有它能生成 `authoritative`。失败结果为 `partial`；单记录来源为 `single_record`。

