# 字幕校订台 · 多人协作 SRT 校订 Web 应用

面向小型放映团队的浏览器字幕校订工具：上传 **UTF-8 编码的 SRT**，按时间轴逐段
校订起止时间与多行文字，多人同时修改时用**作品修订号（乐观锁）**防止互相覆盖，
随时导出重新编号的标准 SRT。

技术栈：Node.js（Express）+ SQLite（sql.js / WebAssembly）+ 原生浏览器界面，
无前端构建步骤。

---

## 功能一览

- **上传校验**：严格按行解析 UTF-8 SRT（支持 CRLF、BOM、逗号或点号毫秒分隔）。
  序号、时间轴格式、时间合法性（非负、结束晚于开始）、**同作品字幕段不得交叠**
  全部通过后才入库；任何一项失败都会返回**出错行号**，且**整份文件不入库**。
- **逐段校订**：按时间顺序展示全部字幕段，可修改开始/结束时间与多行文字，
  行内换行完整保留。
- **批量时间轴平移**：勾选同一作品的若干字幕段，输入有符号整数毫秒偏移量
  （如 `-500`、`1200`），先**预览**每段调整前后的时间、碰撞对象与负起点；
  确认时携带预览所依据的作品修订号，整批在同一事务内同量平移（文字与段标识
  不变）、修订号只增加一次并自动重排展示序号。
- **多人并发保护**：每次保存携带作品修订号。修订号过期时服务器**拒绝覆盖**，
  返回 `409`、最新修订号以及目标字幕段的最新内容；界面就地展示服务器版本，
  校订人人工对照合并后再保存。批量确认同样按修订号乐观锁：预览后作品被他人
  改动则拒绝写入并返回最新修订号，不能按过期预览落库。
- **时间约束**：结束必须晚于开始（时间不可为负），新时间段与同作品其他字幕段
  不得交叠（相邻段首尾相接允许）。批量平移时任一新起点为负、选中段彼此或与
  未选段交叠，都**整批拒绝**并指出原因与相关段；违例保存不推进修订号。
- **导出标准 SRT**：按开始时间重新从 1 连续编号，文字多行换行原样保留，
  输出带 UTF-8 BOM 的标准 SRT 文件。

## 一键启动（Docker Compose）

需要 Docker 20.10+ 与 Docker Compose v2。

```bash
docker compose up -d --build
```

该命令会：

1. 构建镜像并在镜像内 `npm install`（安装依赖）；
2. 首次启动时应用自动创建 SQLite 数据库与全部表（初始化存储）；
3. 以后台方式启动服务，并随 Docker 自动重启。

访问地址：

- 本机：<http://localhost:3000>
- 局域网：`http://<本机 IP>:3000`

停止 / 查看日志：

```bash
docker compose down        # 停止（数据保留在命名卷 srt-data 中）
docker compose logs -f     # 跟踪日志
```

## 配置

所有配置通过环境变量传入，修改后执行 `docker compose up -d` 生效。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `HOST_PORT` | `3000` | 宿主机映射端口。例如 `HOST_PORT=8080 docker compose up -d --build` 后访问 <http://localhost:8080> |
| `PORT` | `3000` | 容器内监听端口，一般无需修改（改动需同步调整 compose 端口映射右侧） |
| `DB_PATH` | `/data/subtitles.db` | 容器内数据库文件路径，位于持久化卷中 |

数据保存在 Docker 命名卷 `srt-data`（挂载于容器 `/data`）。
如希望直接映射到宿主机目录，可把 `docker-compose.yml` 中的

```yaml
volumes:
  - srt-data:/data
```

改为

```yaml
volumes:
  - ./data:/data
```

> 存储说明：SQLite 通过 sql.js（WebAssembly）运行，每次写事务提交后把数据库
> 原子快照写回磁盘（先写临时文件再 rename）。对放映团队这种几十至几千段字幕、
> 少量并发校订的场景完全够用；读取始终在内存中完成，速度很快。

## 不用 Docker 的本地运行

需要 Node.js 18+。

```bash
npm install
npm start
```

默认数据库写到项目下 `data/subtitles.db`，访问 <http://localhost:3000>。
可用环境变量覆盖：

```bash
PORT=8080 DB_PATH=/var/lib/srt/sub.db npm start
```

## 运行测试

测试使用内存数据库，不产生任何文件：

```bash
npm test
```

覆盖：SRT 解析各类非法输入与行号定位、多行文字、交叠检测、整份不入库、
乐观锁 409 冲突（含并发双写）、时间/交叠拒绝不推进修订号、批量平移预览
（负起点/交叠/首尾相接）、批量确认单事务重算与重排、过期预览 409、
导出重新编号与换行保留、重启持久化等 35 个用例。

## HTTP 接口摘要

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/works` | 作品列表（含段数、修订号） |
| `POST` | `/api/works` | 上传 SRT：`{title, filename, content}`；失败返回 `422 {error:"invalid_srt", line, message}`，不入库 |
| `GET` | `/api/works/:id` | 作品详情与按时间排序的字幕段 |
| `PUT` | `/api/works/:id/cues/:cueId` | 保存单段：`{revision, start, end, text, editor?}`；修订号过期返回 `409 {latest_revision, cue}`，时间/交叠非法返回 `422` |
| `POST` | `/api/works/:id/cues/shift/preview` | 批量平移预览（不写库），见下 |
| `POST` | `/api/works/:id/cues/shift` | 确认批量平移：同事务重算应用、修订号 +1、重排展示序号；过期 `409 {latest_revision}`，非法 `422 {issues, cues}` |
| `GET` | `/api/works/:id/export` | 下载按时间重新编号的标准 SRT |
| `DELETE` | `/api/works/:id` | 删除作品及其全部字幕段 |

## 批量时间轴平移 API

两个接口的请求体相同：

```json
{
  "revision": 4,
  "cue_ids": [12, 15, 18],
  "offset_ms": -500,
  "editor": "阿校对"
}
```

- `revision`（必填）：作品修订号正整数。
- `cue_ids`（必填）：非空、无重复的字幕段 ID 数组；段不存在或不属于该作品
  返回 `404 cue_not_found` 并附 `cue_ids`；空数组 `400 empty_selection`；
  重复 `400 duplicate_cue`。
- `offset_ms`（必填）：有符号**整数**毫秒偏移。数字或整数字符串均可
  （`-500`、`"1200"`、`0`）；小数（`1.5`）、非数字均返回 `400 invalid_offset`。
- `editor`（仅确认接口，选填）：校订人署名，随修订记录保存。

### 1) 预览 `POST /api/works/:id/cues/shift/preview`

只推演不写库，返回预览所依据的修订号 `expected_revision`、每段调整前后的
时间（毫秒与 `HH:MM:SS,mmm`）、碰撞对象列表，以及全部违例：

```bash
curl -X POST http://localhost:3000/api/works/1/cues/shift/preview \
  -H 'Content-Type: application/json' \
  -d '{"revision":1,"cue_ids":[2],"offset_ms":2500}'
```

假设作品当前为 #1 1s–2s、#2 3s–4s、#3 5s–7s、#4 9s–10s，#2 平移 2500ms 后
变为 5.5s–6.5s，与原地的 #3 交叠，返回：

```json
{
  "revision": 1,
  "expected_revision": 1,
  "stale": false,
  "offset_ms": 2500,
  "cue_ids": [2],
  "valid": false,
  "issues": [
    {
      "type": "overlap",
      "cue_ids": [2, 3],
      "cues": [{"id": 2, "idx": 2}, {"id": 3, "idx": 3}],
      "message": "展示序号 #2（段 ID 2）调整为 00:00:05,500 --> 00:00:06,500 后，与 1 个字幕段交叠：#3（首尾相接不算交叠）"
    }
  ],
  "cues": [
    {
      "id": 2, "idx": 2,
      "start": "00:00:03,000", "end": "00:00:04,000",
      "new_start": "00:00:05,500", "new_end": "00:00:06,500",
      "start_ms": 3000, "end_ms": 4000,
      "new_start_ms": 5500, "new_end_ms": 6500,
      "negative_start": false, "out_of_range": false,
      "collisions": [
        {"id": 3, "idx": 3, "start": "00:00:05,000", "end": "00:00:07,000", "selected": false}
      ]
    }
  ]
}
```

若 #2 只平移 1000ms（变为 4s–5s，新终点正好等于 #3 起点 5s，首尾相接），则
`valid: true`、`issues` 与 `collisions` 均为空数组。

`issues[].type` 为 `negative_start`（新起点为负）、`overlap`（交叠）或
`time_out_of_range`（超出可表示范围）。`valid: true` 时 `issues` 为空数组，
`cues[].collisions` 也为空。

### 2) 确认 `POST /api/works/:id/cues/shift`

必须携带**预览返回的 `expected_revision`**。服务器在同一事务内：校验修订号 →
重算全部时间（负起点/交叠则回滚）→ 更新选中段 → 修订号 +1 → 重排全部展示
序号。文字与段 ID 不变。

```bash
curl -X POST http://localhost:3000/api/works/1/cues/shift \
  -H 'Content-Type: application/json' \
  -d '{"revision":1,"cue_ids":[2,3],"offset_ms":-500,"editor":"阿校对"}'
```

成功返回新修订号与按新时间重排的全部字幕段：

```json
{ "revision": 2, "offset_ms": -500, "shifted_count": 2, "cues": [ /* 全部段，idx 已重排 */ ] }
```

- 作品在预览后被他人改动：`409 {"error":"revision_stale","latest_revision":N}`，
  本次不写入；请重新 `GET` 作品、重新预览后携带 N 确认。
- 会产生负起点或交叠：`422 {"error":"shift_rejected","issues":[...],"cues":[...]}`，
  整批回滚、修订号不变。

随后 `GET /api/works/:id/export` 导出的 SRT 自动按新时间排序、从 1 连续编号。

## 目录结构

```
.
├── Dockerfile
├── docker-compose.yml
├── package.json
├── README.md
├── src/
│   ├── server.js      # Express 路由：上传/编辑/批量平移/导出、乐观锁与交叠校验
│   ├── shift.js       # 批量平移推演（负起点/交叠检测，碰撞对象）
│   ├── db.js          # SQLite 存储（sql.js wasm，快照持久化，建表初始化）
│   └── srt.js         # SRT 严格解析（带行号报错）与标准序列化
├── public/            # 浏览器界面（原生 HTML/CSS/JS）
│   ├── index.html
│   ├── styles.css
│   └── app.js
└── test/test.js       # 单元 + HTTP 集成测试
```

## 使用流程建议

1. 一位同学上传片方字幕，其他人在作品列表中打开同一作品；
2. 各人在「校订人署名」填自己的名字（随修改记录保存）；
3. 改一段点一段的「保存」。若期间别人先保存过，该段会出现黄色冲突提示，
   其中附有服务器最新内容；对照合并后再次保存即可；
4. 需要整体挪动时间轴时，勾选若干字幕段（或「全选」），在工具条输入有符号
   整数毫秒偏移量并点「预览调整」：面板逐段列出调整前后时间与碰撞对象；
   绿色表示可应用，红色会逐条指出负起点/交叠及相关段。点「确认应用」整批
   同量平移，修订号只增加一次、展示序号自动重排；若预览后作品被他人改动，
   会收到 409 提示，重新载入并重新预览即可；
5. 校订完成后点右上角「导出标准 SRT」，文件可直接用于放映软件。
