# ADR-011: Web content is untrusted

网页和 ATS 响应均为不可信输入。Connector 必须限制协议、重定向、响应大小和私网访问；展示层净化 HTML，抓取内容不能成为执行指令。

