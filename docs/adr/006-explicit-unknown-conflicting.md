# ADR-006: Unknown and conflicting are first-class

高风险字段使用 `known/unknown/conflicting`。SQL `NULL` 只表示某个具体值不存在，不能隐式代表 unknown；冲突值和各自证据必须保留。

