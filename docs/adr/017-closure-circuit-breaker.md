# ADR-017: Closing requires interval and circuit safety

只有成功 authoritative 集合快照增加缺失计数，且两次计数满足最小时间间隔。异常为零、缺失比例超过 50% 或一次缺失超过 25 时降级并人工审核，岗位状态不变。

