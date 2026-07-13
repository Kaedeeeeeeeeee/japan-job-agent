# ADR-013: Source Instance and Company are decoupled

`source_instances` 不含 Company ID。一个 Source Instance 可服务多个 Company，一个 Company 可关联多个 Source Instance；关系有生效区间、验证状态和证据。

