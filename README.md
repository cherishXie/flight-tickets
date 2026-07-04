# 节假日航线价格监控

一个面向个人使用的 v1 原型，用于监控从上海出发的节假日机票价格。

当前版本优先实现产品闭环：

- 系统内置推荐节假日。
- 系统内置推荐目的地。
- 系统优先推荐节假日 + 目的地组合。
- 内置 20+ 个候选目的地和 11 组系统推荐组合，覆盖国内、港澳台、东北亚和东南亚。
- 用户可以一键创建监控任务，也可以手动输入。
- 用户可以基于系统推荐调整日期、目的地、预算和直飞 / 中转策略后再创建任务。
- 支持节假日前后日期浮动，并按候选日期组合分别采集价格。
- 直飞和中转作为不同策略分别记录。
- 支持本地模拟价格源，也支持通过本地服务端代理接入 Amadeus 真实机票报价。
- 支持在任务详情手动录入真实查到的价格快照。
- 支持在任务详情批量导入 CSV 价格快照，适合从航司、OTA 或表格整理后导入。
- 根据预算、历史低价、近期均价生成邮件提醒预览。
- 任务详情页展示直飞 / 中转策略对比、价格快照和提醒记录。
- 根据预算、历史低价和近期均价生成入手建议。
- 支持保存收件邮箱、提醒冷却时间和默认币种。
- 支持页面打开期间按固定间隔自动采集。
- 支持按任务自动清理旧价格快照，避免长期个人使用时本地数据无限增长。
- 支持本地旅客档案，记录任务归属、收件邮箱、出发城市和出发机场。
- 支持导出 / 导入 JSON 备份本地数据。
- 支持手动输入自定义节假日，并在后续任务中复用。
- 支持手动输入自定义目的地，并在后续任务中复用。

## 技术方案

v1 使用无依赖静态 Web App：

- `index.html`：页面入口。
- `src/data.js`：内置节假日、目的地、推荐预设。
- `src/priceSources.js`：浏览器侧价格来源适配层，统一模拟采集、真实 API、手动录入和 CSV 导入的快照结构。
- `src/externalSearchLinks.js`：根据价格快照生成航司官网、OTA 和 Google Flights 外部查询入口。
- `src/notifications.js`：邮件提醒适配层，生成 `mailto:` 链接、`.eml` 文件内容，并预留 SMTP / 第三方邮件 API。
- `src/pricing.js`：推荐评分、模拟价格快照、提醒判断。
- `src/app.js`：界面渲染、本地持久化、任务和提醒交互。
- `src/styles.css`：界面样式。
- `scripts/serve.mjs`：无依赖本地静态服务器，同时提供真实价格 API 代理。
- `scripts/amadeusFlightSource.mjs`：Amadeus OAuth 和 Flight Offers Search 适配器。
- `scripts/smokeLivePriceSource.mjs`：真实价格源命令行烟测脚本，用于验证 API key、航线查询和真实报价快照转换。
- `scripts/checkLiveReadiness.mjs`：真实监控命令行就绪检查脚本，适合在系统定时任务前置验证。
- `scripts/collectLiveOnce.mjs`：浏览器外一次性真实采集脚本，适合接入系统定时任务。
- `scripts/runLiveMonitor.ps1`：Windows 任务计划包装脚本，串联就绪检查、真实采集、报告落盘和 `.eml` outbox。
- `scripts/localEnv.mjs`：读取 `.env.local` / `.env` 的本地环境变量工具。
- `tests/recommendation.test.mjs`：核心推荐和价格规则测试。

选择静态 App 的原因：

- 当前仓库没有既有框架，先避免引入依赖和构建复杂度。
- 适合快速验证“系统推荐优先”的产品流程。
- 后续可以平滑迁移到 React / Next.js / 后端服务。

## 本地运行

可以直接启动一个本地静态服务器：

```bash
node scripts/serve.mjs
```

然后访问：

```text
http://127.0.0.1:4173/
```

如果设置页提示真实价格 API 不可用，或直接访问 `/api/price-source-status` 返回的是 HTML，请确认当前端口运行的是 `node scripts/serve.mjs`。只使用普通静态预览服务时，页面仍可打开，但无法通过本地代理访问 Amadeus 真实价格。

## 接入真实机票价格

当前已接入 Amadeus Flight Offers Search。浏览器不会直接访问 Amadeus，也不会保存 API Secret；所有真实价格请求都通过本地 Node 服务端代理完成。

1. 到 Amadeus for Developers 创建应用，获取 API Key 和 API Secret。
2. 复制 `.env.example` 为 `.env.local`。
3. 在 `.env.local` 中填写：

```text
AMADEUS_CLIENT_ID=你的 API Key
AMADEUS_CLIENT_SECRET=你的 API Secret
AMADEUS_ENV=test
# 可选：同一查询参数的缓存时间，默认 30 分钟
AMADEUS_CACHE_TTL_MINUTES=30
# 可选：服务端硬限制，默认 24 次
AMADEUS_MAX_QUERIES_PER_RUN=24
# 可选：单个 Amadeus HTTP 请求超时，默认 20000 毫秒
AMADEUS_REQUEST_TIMEOUT_MS=20000
# 可选：网络错误、429 或 5xx 的重试次数，默认 1 次，最多 3 次
AMADEUS_RETRY_COUNT=1
```

如需让后台脚本自动发送邮件提醒，可以继续配置 SMTP：

```text
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_REQUIRE_TLS=true
SMTP_USER=alerts@example.com
SMTP_PASS=你的 SMTP 密码或应用专用密码
SMTP_FROM=alerts@example.com
SMTP_TIMEOUT_MS=20000
```

4. 启动服务：

```bash
node scripts/serve.mjs
```

5. 打开设置页，把“自动价格源”切换为 `Amadeus 真实价格`，点击“刷新配置”确认本地服务读到了环境变量。
6. 点击“测试真实连接”，系统会向 Amadeus OAuth 端点请求 token，验证 API Key / Secret 是否真的可用。

也可以先不打开浏览器，直接运行真实价格源烟测：

```bash
node scripts/smokeLivePriceSource.mjs --origin PVG --destination osaka-kyoto --depart 2026-10-01 --return 2026-10-07 --strategy direct
```

也可以使用 `npm run smoke:live -- --origin PVG --destination osaka-kyoto --depart 2026-10-01 --return 2026-10-07 --strategy direct`。烟测会先验证 Amadeus OAuth，再查询一条真实航线报价，并输出 JSON 报告。只有当 `snapshots` 里出现 `sourceType: "live_api"`、`sourceProvider: "amadeus"`、真实价格、航司和 `rawProviderOfferId` 时，才代表真实价格链路已经跑通。未配置密钥会返回退出码 `2`；密钥可用但该航线没有报价会返回退出码 `3`，可换热门航线或把 `AMADEUS_ENV` 切到具备权限的环境继续验证。

准备接入后台定时任务前，可以用导出的备份做一次命令行就绪检查：

```bash
node scripts/checkLiveReadiness.mjs --input flight-tickets-backup.json --collect-command --report-output flight-readiness-report.json
```

检查会验证备份是否已选择 Amadeus、是否有启用任务、是否配置提醒邮箱，以及本机 `.env.local` 里的 Amadeus OAuth 是否可用。所有必需项通过时退出码为 `0`；缺少必需项时退出码为 `2`，报告中会列出需要处理的项目。`--report-output` 会把就绪检查结果写入 JSON 文件，便于归档和排查；报告内也会写入 `status` 和 `exitCode`。如果后台任务需要自动发邮件，可以追加 `--smtp`，就绪检查会先验证 SMTP 配置、TLS 和登录状态。

说明：

- `.env.local` 已被 `.gitignore` 忽略，请不要把真实 API Key 提交到仓库。
- 设置页会区分三种状态：未配置、已配置待验证、连接已验证。只有“连接已验证”才代表密钥和网络都可用。
- 设置页会显示“真实监控就绪度”，检查真实价格源、Amadeus 连接验证、启用任务、提醒邮箱和运行方式，避免误以为模拟价或未验证连接已经在真实监控。
- 当自动价格源选择 Amadeus 时，手动采集和自动采集都会先做一次深度连接预检；预检失败时不会继续逐个任务查询真实报价。
- 真实价格采集会受到“每次采集最多真实查询次数”限制，默认 24 次，避免一个多目的地、多日期浮动任务一次性消耗过多 API 配额。
- 同一航线、日期、乘客数、直飞/中转策略和报价数量的 Amadeus 查询会在服务端内存缓存中保留 30 分钟；缓存命中不会消耗真实查询预算。
- Amadeus 请求默认 20 秒超时，并对网络错误、429 或 5xx 做 1 次重试；可以用 `AMADEUS_REQUEST_TIMEOUT_MS` 和 `AMADEUS_RETRY_COUNT` 调整，避免后台定时任务长时间卡住。
- `AMADEUS_ENV=test` 使用 Amadeus 测试环境，数据覆盖有限；如果部分航线没有返回报价，可以先用大城市或热门机场验证。
- `AMADEUS_ENV=production` 会使用生产环境 API，需要 Amadeus 账号具备相应权限。
- Amadeus 返回的是报价和行程信息，不一定包含可直接出票的深链；系统会为每条价格快照生成 Google Flights、携程、Trip.com 和航司官网查询入口，方便复核价格并完成购买。
- 监控价格用于发现低价机会；实际购买前请在外部查询入口确认最终票价、税费、行李额度、退改规则和库存。
- 航司官网和 OTA 页面通常有登录、验证码、反爬和服务条款限制；当前版本优先使用官方 API。后续可以在同一价格源适配层继续接入携程、Skyscanner、航司 NDC 或其他授权 API。

### 浏览器外定时采集

如果不想一直打开浏览器，可以把设置页导出的 JSON 备份作为输入，运行一次性真实采集脚本：

```bash
node scripts/collectLiveOnce.mjs --input flight-tickets-backup.json --output flight-tickets-backup.json
```

脚本会读取备份里的启用任务，使用 Amadeus 真实价格源采集价格，追加价格快照和提醒记录，应用旧快照清理规则，再写回新的 JSON 备份。
为避免误用真实 API 配额，脚本默认要求备份中的“自动价格源”已经切换为 `Amadeus 真实价格`；如果确实需要覆盖备份设置，可以显式追加 `--force-amadeus`。

如果希望后台采集触发提醒时同时生成邮件文件，可以指定 outbox 目录：

```bash
node scripts/collectLiveOnce.mjs --input flight-tickets-backup.json --output flight-tickets-backup.json --eml-outbox flight-alert-outbox --report-output flight-alert-report.json
```

脚本会为本次新增提醒生成 `.eml` 文件，文件内容与页面里的邮件提醒草稿一致，包含价格、来源元数据、购票 / 复核链接和购买前复核提示。`--report-output` 会把本次采集报告写成 JSON 文件，方便在 Windows 任务计划程序里排查真实源状态、查询次数、提醒数量、outbox 写入情况、`status` 和 `exitCode`。`--dry-run` 会在报告里统计将生成的邮件数量，但不会写入备份或邮件文件。

如果 `.env.local` 已配置 SMTP，可以追加 `--smtp` 让命令行采集在触发提醒时直接发送邮件；发送成功的提醒会标记为 `sent`，发送失败会写入报告的 `warnings`、`smtpEmailErrors`，但不会阻断价格采集和备份写回：

```bash
node scripts/collectLiveOnce.mjs --input flight-tickets-backup.json --output flight-tickets-backup.json --smtp --report-output flight-alert-report.json
```

也可以先试跑不写文件：

```bash
node scripts/collectLiveOnce.mjs --input flight-tickets-backup.json --dry-run
```

在 Windows 上推荐把包装脚本放进“任务计划程序”，例如每天早晚各运行一次：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/runLiveMonitor.ps1 -BackupPath flight-tickets-backup.json -OutputPath flight-tickets-backup.json -EmlOutbox flight-alert-outbox -ReportDir flight-monitor-reports -MaxReportFiles 120 -MaxOutboxFiles 300 -Smtp
```

包装脚本会先运行 `checkLiveReadiness.mjs`，通过后再运行 `collectLiveOnce.mjs`；两步都会把 JSON 报告写入 `ReportDir`。`MaxReportFiles` 和 `MaxOutboxFiles` 分别控制报告目录和 `.eml` outbox 的保留数量，默认保留最近 120 个报告文件和 300 个邮件文件，方便长期挂在任务计划程序里运行。`-Smtp` 会把 `--smtp` 同时传给就绪检查和采集脚本：SMTP 不可用时任务会在采集前失败，避免价格已采集但提醒没有发出去。如果只是生成 `.eml` outbox，不需要追加这个参数。就绪检查失败时也会执行报告保留清理，避免反复失败造成报告目录无限增长。如果只是演练，可以追加 `-DryRun`；演练模式不会写入备份、邮件文件、发送 SMTP 邮件，也不会删除旧报告或旧 outbox 文件。运行后再把输出 JSON 导入设置页，就能在浏览器里查看最新价格历史和提醒记录。

## 测试

```bash
node tests/recommendation.test.mjs
```

说明：`npm test` 也配置了同一个测试命令，但部分本机 npm 环境可能会输出 npm 目录提示；直接运行 Node 测试更干净。

## v1 已实现能力

### 系统推荐

系统会展示推荐卡片，例如：

- 国庆东亚人文与城市线。
- 中秋近程人文与海滨线。
- 春节避寒海岛与东南亚线。
- 五一国内自然与古城线。
- 元旦近程直飞轻旅行。
- 春节雪景温泉线。
- 清明短假人文与海滨线。
- 端午海滨与近程国际线。
- 国庆国内长线自然线。

每个推荐包含：

- 推荐节假日。
- 推荐日期范围。
- 推荐目的地组。
- 直飞 / 中转策略。
- 预算建议。
- 推荐理由。

当前内置 11 组推荐组合，并会优先展示适合从上海出发、价格潜力较好且兼顾自然风景或历史人文的线路。
推荐卡支持两种创建方式：直接一键创建，或先填入手动表单作为草稿，再修改日期、目的地、预算和监控策略后创建。

### 监控任务

用户可以从推荐卡片一键创建任务，也可以手动输入：

- 任务名称。
- 节假日。
- 目的地。
- 出发日期。
- 返程日期。
- 前移 / 后移浮动天数。
- 乘客人数。
- 单人预算。
- 直飞 / 中转策略。

新建任务会绑定到当前旅客档案，并使用档案中的出发城市和机场代码。默认档案为上海出发（PVG / SHA），符合当前个人使用场景；后续扩展多人使用时，可以把本地档案迁移为用户账号或家庭成员档案。

手动创建支持同时选择多个候选目的地。任务创建后，系统会对每个目的地分别采集价格，并继续把直飞和中转作为不同策略记录。

任务创建后可以暂停 / 恢复、标记已购票、手动采集、清空该任务的价格和提醒记录，或删除任务。标记已购票会停止后续自动采集但保留历史记录；删除任务会同时移除该任务关联的价格快照和提醒。

任务列表支持按关键词、启用 / 暂停 / 已购票状态、提醒处理状态筛选，也可以按入手建议、当前低价、出发日期或最近更新时间排序。列表会汇总未处理提醒数量，帮助优先查看需要行动的低价机会。

任务详情中可以编辑监控配置，包括任务名称、出发 / 返程日期、日期浮动、乘客人数、单人预算、直飞 / 中转策略和候选目的地。保存时默认保留历史，也可以选择同步清空该任务已有价格快照和提醒。

手动输入时，可以选择内置节假日，也可以填写新节假日名称并指定出发 / 返程日期。自定义节假日会保存到浏览器本地，之后会显示在手动创建下拉框里。

手动输入时，可以选择内置目的地，也可以填写新目的地：

- 目的地名称。
- 国家或地区。
- 机场代码。
- 目的地标签。
- 预估直飞价。
- 预估中转价。
- 是否国内航线。

自定义目的地会保存到浏览器本地，之后会显示在目的地库和手动创建下拉框里。

目的地库支持按关键词、国内 / 国际及港澳台、标签筛选，方便在 20+ 个候选目的地里快速找到自然风景、人文、美食、海滨或性价比线路。

任务保存到浏览器 `localStorage`，刷新页面后仍可继续查看。

设置页提供数据备份面板，可以生成 JSON 导出文本，也可以粘贴之前导出的 JSON 恢复任务、价格快照、提醒、设置和自定义节假日 / 目的地。
备份也会包含旅客档案和当前活跃档案，方便换设备或后续迁移到后端数据库。

### 价格采集

当前版本支持两类自动价格源：

- 模拟价格源：用于无 API key 时验证产品流程和数据结构。
- Amadeus 真实价格源：通过本地服务端代理查询 Flight Offers Search，并转换成统一价格快照。

每次采集会记录：

- 航线。
- 出发 / 到达机场。
- 出发 / 返程日期组合。
- 直飞或中转。
- 中转城市。
- 航司。
- 耗时。
- 价格。
- 是否含税费。
- 是否含托运行李。
- 外部查询入口，例如 Google Flights、携程、Trip.com 和航司官网。

每条价格快照都会保留来源元数据：`sourceType` 用于区分 `mock`、`live_api`、`manual`、`csv_import`，`sourceProvider` 用于记录 Amadeus、航司官网、OTA 或手动来源，`sourceCategory` 用于按 `official_airline`、`ota`、`meta_search`、`live_api`、`manual`、`csv_import`、`simulation` 分组，`sourceVerifiedAt` / `rawProviderOfferId` 用于保留真实 API 报价的校验时间和供应商报价 ID。这样可以在图表、提醒、导出和后续数据库迁移时区分真实报价、人工复核价和模拟价。

当前自动采集已经通过 `src/priceSources.js` 调用统一价格来源接口；Amadeus 由 `scripts/amadeusFlightSource.mjs` 转换成 `FlightPriceSnapshot`，任务、提醒、图表和导入逻辑无需重写。报价表和邮件提醒会附带外部查询入口，用户可以跳转到 OTA、航司官网或 Google Flights 复核并购买。

可以在顶部按钮启动 / 停止自动采集，也可以在设置页配置自动采集间隔。静态 v1 的自动采集只在页面打开期间运行；关闭浏览器后不会后台执行。

设置页默认开启旧快照自动清理，每个任务保留最近 600 条价格快照；可以调整保留数量，也可以手动立即清理。清理旧快照时会同步移除引用这些快照的旧提醒记录，避免提醒列表出现无法对应价格的残留数据。

系统推荐任务会默认使用节假日内置的前后浮动天数；手动任务可以自行设置前移 / 后移天数。采集时会按每个候选日期组合生成独立价格快照，历史低价和提醒判断也按日期组合隔离。

在任务详情中也可以手动录入真实查到的价格，字段包括目的地、日期组合、直飞 / 中转策略、单人价格、航司、耗时、中转城市、来源、购票链接和是否含托运行李。手动录入后会立即进入历史统计、入手建议和邮件提醒判断。

如果一次整理了多条价格，可以在任务详情中使用 CSV 批量导入。CSV 表头为：

```csv
destination,departDate,returnDate,strategyType,priceAmount,airline,durationMinutes,transferCities,source,sourceType,sourceProvider,sourceCategory,bookingUrl,includesCheckedBag
```

其中 `destination` 可以填写当前任务中的目的地 ID 或目的地名称，`strategyType` 使用 `direct` 或 `transfer`，`transferCities` 如果包含逗号需要用英文双引号包裹。`sourceType` 建议 CSV 导入使用 `csv_import`，`sourceProvider` 可填写 `official-airline`、`ctrip`、`trip.com` 等，`sourceCategory` 可填写 `official_airline`、`ota`、`meta_search` 或 `csv_import`。导入成功后，每一行都会作为独立价格快照进入趋势统计、日期热力和提醒判断。

### 任务详情

每个监控任务都可以打开详情页，查看：

- 基础配置和当前最低价。
- 入手建议：可以入手、值得关注、可以观望、继续观望。
- 当前最佳候选方案。
- 单人价格、乘客人数和预计总价。
- 价格趋势图和候选日期低价热力格。
- 直飞 / 中转策略对比。
- 历史最低价。
- 近 30 次均价。
- 较上次采集的涨跌趋势。
- 最近价格快照表。
- 候选日期组合及每组当前最低价。
- 该任务触发过的提醒记录。

价格快照表支持按目的地、直飞 / 中转策略、日期组合和来源类别筛选，并可以把当前筛选结果导出为 CSV，用于后续表格分析或留档。CSV 会包含主购票链接、来源元数据和 `externalSearchLinks`，方便保留 Google Flights、携程、Trip.com、航司官网等复核入口。

### 邮件提醒

浏览器内会生成邮件提醒预览，不会直接发送外部邮件；后台命令行采集可以通过 `--smtp` 使用 `.env.local` 中的 SMTP 配置自动发送。

触发条件：

- 当前价格低于预算。
- 当前价格刷新该任务历史最低。
- 当前价格低于近期均价一定比例。

提醒规则可以在设置页配置：预算提醒、历史低价提醒、近期均价提醒都可以单独开关，近期均价折扣阈值也可以调整。

提醒记录中提供 `mailto:` 链接，点击后可以用本机邮件客户端打开预填邮件；同时提供 `.eml` 下载，适合没有默认邮件客户端、想手动发送或归档提醒内容的场景。

命令行采集触发提醒时也可以生成 `.eml` outbox，或通过 SMTP 直接发送到旅客档案 / 设置里的收件邮箱。

邮件预览会包含历史最低价、近 30 次均价、提醒冷却信息和外部查询入口，方便判断本次提醒是否值得行动。邮件也会提示购买前需要复核最终价格、税费、行李和退改规则。

提醒记录可以标记为已处理或忽略，便于区分仍需查看的低价机会和已经处理过的提醒。

### 设置

设置页支持配置：

- 旅客档案：显示名称、档案邮箱、出发城市、出发机场代码、偏好标签。
- 新增和切换本地旅客档案。
- 收件邮箱。
- 提醒冷却时间。
- 提醒规则开关和近期均价折扣阈值。
- 默认币种。
- 自动采集间隔。
- 自动价格源：模拟价格源或 Amadeus 真实价格。
- 单次真实查询最多报价数量。
- 每次采集最多真实查询次数，用于控制 Amadeus API 配额消耗。
- 页面打开期间自动采集开关。
- 旧价格快照自动清理开关。
- 每个任务保留的最大价格快照数量。
- 手动立即清理旧价格快照。
- 查看当前启用的价格来源：模拟价格源、Amadeus 真实价格、手动录入、CSV 批量导入。
- 查看当前提醒通道：本机邮件客户端、`.eml` 文件导出，以及后台命令行 SMTP 自动发送。
- 导出 / 导入本地数据备份。

这些设置保存在浏览器 `localStorage` 中。邮件提醒预览会使用这里配置的收件邮箱和冷却时间。

## 后续建议

1. 接入更多授权数据源，例如航司 NDC、OTA API 或聚合搜索 API。
2. 将 `localStorage` 持久化替换为数据库。
3. 接入第三方邮件 API，并在多人模式下提供可视化发送日志。
4. 增加用户账号和多人使用能力。
5. 增强价格曲线和日期热力图，例如按航司、策略和日期组合筛选。
6. 增加签证、行李、退改和中转签提示。
