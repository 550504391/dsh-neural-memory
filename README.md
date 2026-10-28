# 类神经记忆 · v0.4.1

DeepSeek Harness 的外部记忆插件：把记忆存成外部文件，按需召回，用关系扩散补充字面匹配，附带三套可视化。

纯本地、零依赖、227 项测试。

---

## 功能

```
外部记忆     记忆存成单个 JSON（节点 + 边），换会话时按重要性 + 日期挑几条注入
召回         字面匹配（4 字片段重合）+ 沿边扩散一层；preview 模式不强化
入库         手动灌入 / HTTP 接口 / Python 批量导入（按前 200 字指纹去重）
关系         同文件相邻段自动连（0.1）；跨来源生成候选桥，人工确认 0.45 或放超时 0.25
可视化       球（半径 = 存活度衰减）/ 涟漪（召回扩散）/ 网页面板（八块）
接口         HTTP（remember / connect / recall / disconnect / bridge / stats / bridges /
             graph-data / snapshot / export）
```

## 不做的部分

```
不是人脑模拟        字面匹配 + 一层关系扩散，无 neural network，无 embedding
不保证不丢上下文    会话压缩照常发生，插件只是提前留一份外部副本
召回仍是字面匹配    同义词、口语化说法召回不到
不保证可无限扩展    两万条实测可用（出图 311ms / 搜索 47ms），五万条以上变慢
```

## 安装

```bash
# 1. 插件目录放到本地插件位置，例如 ~/.dsh/plugins/dsh-neural-memory

# 2. profile 的 package.json
#    dependencies:          "dsh-neural-memory": "file:../../plugins/dsh-neural-memory"
#    dsh.profile.bundles:   "dsh-neural-memory"

# 3. profile 目录内
pnpm install && 重启 DSH
```

依赖必须写 `file:`。写成版本号会让 pnpm 去 npm 商店找，找不到。

面板：`http://127.0.0.1:<port>/neural-panel`（包内附 `打开面板.cmd` 自动找端口）。

## 测试

零依赖，纯 Node：

```bash
cd 插件/dsh-neural-memory
for f in test/*.test.mjs; do node "$f"; done
```

| 文件 | 覆盖 | 项数 |
|---|---|---|
| core | 节点/边/召回/衰减/导出 | 31 |
| lock | 跨进程文件锁 | 20 |
| concur | 多 Node 进程并发写 | 8 |
| reliability | 坏库/半写/备份/原子性 | 44 |
| bridge | 候选桥/人工确认/超时/黑名单 | 29 |
| compat | 路由形状与错误码 | 50 |
| inject | 注入（pre-step / created 兜底 / 去重） | 37 |
| sidefile | 辅助文件原子写与损坏检测 | 7 |
| smoke-real | 真实库只读冒烟 | 27 |

## 目录

```
插件/dsh-neural-memory/   插件（lib/core.js + lib/index.js + 三个页面 + cordis.patch.yml + test）
脚本/                     Python：灌入 / 统计 / 导出 / 按天拆 / 布局计算
数据/                     空库结构 + 示例数据
示例/                     可灌入的示例文本
说明书.md                 原理、参数、备份、已知限制
故障恢复.md               常见故障的症状与处理
安全边界-可选.md          用于角色扮演/陪伴场景前的注意事项
审查记录.md               外部评审意见与逐条处理
```

## 数据与隐私

`数据/neural-memory.json` 为使用者自身数据，不应提交或分发。
插件仅读写本地文件，不发起网络请求。

## License

MIT
