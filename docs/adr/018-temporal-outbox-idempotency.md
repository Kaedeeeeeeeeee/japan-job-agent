# ADR-018: Temporal and Outbox are idempotent

同步请求、Activity、Raw、Extraction 和事件分别使用稳定幂等键。Outbox Publisher 通过租约和 `FOR UPDATE SKIP LOCKED` 竞争；Consumer 以 `(consumer_name,event_id)` 在同一事务中登记并执行副作用。

