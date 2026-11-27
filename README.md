# dsh-choerodon

把猪齿鱼（Choerodon）的账号、项目上下文、任务看板、评论与项目模型接进 DeepSeek Harness。
Host 半区负责登录、平台请求与模型路由，Client 半区提供左侧「猪齿鱼」面板。

## 装法

插件是纯 ESM，无第三方依赖、无构建步骤，`index.js` 与 `client.js` 就是运行时产物。

已在 DSH 0.2.2-rc.5 / 0.2.3（desktop profile）上验证。

从 GitHub 装：

```
dsh plugin --profile <profile> add git+https://github.com/liushutong123/dsh-choerodon-plugin.git
```

在 DSH 里也可以让 agent 执行：

```
plugin_manager install_bundle target=<插件目录绝对路径>
```

或者用打好的 tarball：

```
plugin_manager install_bundle target=file:<dsh-choerodon-0.9.1.tgz 的绝对路径>
```

装完重启 DSH。侧栏出现「猪齿鱼」，设置里的插件列表会出现 `dsh-choerodon`。

手工登记等价于下面两条（profile 目录下的 `package.json`）：

```json
{
  "dependencies": { "dsh-choerodon": "link:<插件目录绝对路径>" },
  "dsh": { "profile": { "bundles": ["dsh-choerodon"] } }
}
```

`cordis.patch.yml` 会用 `insert` 加一行 `id: choerodon` 的 loader entry，不需要手工改 profile 的 patch 层。

## 用法

1. 左侧「猪齿鱼」→「模型接入」登录（账号密码 / 浏览器授权 / 粘贴 access_token）。
2. 选组织与项目，点「刷新并接入模型」。插件会在该项目下复用一个名为 `DSH 模型代理` 的常驻会话，
   把模型以 `choerodon-` 前缀写进 DSH 模型选择器。
3. 「任务看板」按状态分泳道看工作项，**默认只看自己经办的**；点「全部」看所有人的。
   工具栏「史诗筛选」「经办人筛选」都可多选、可搜索，勾选即重查，泳道上的数字是过滤后的真实总数。
   明确勾了经办人时以筛选为准（比如只勾同事，就只看同事的，不再叠加「我的」）。
   工具栏右侧的搜索框按概要/描述正文匹配（回车执行、Esc 清空），命中结果单独列成一张可点开的清单。
4. 卡片详情里可以改经办人（选一个项目成员、改为我、清空）、写评论、改工时、
   点可流转状态切状态，也能按任务开工作分支：新建分支（`feature-<编号>` / `bugfix-<编号>`，
   落在仓库的 `.worktrees/`）或固定分支（就地开发，不动 Git）。
5. 建会话的弹窗里先选**经办人怎么处理**：保持原经办人（默认，不动别人名下的单）、改为我、
   或指定某个项目成员（带搜索的浮层，默认只列前 10 条，按姓名或工号筛）；
   另外可以取消「同时把状态推进到开发中」。以前不管谁的单都会被改成自己、
   状态也一定被推走，现在两个动作都由你决定。
6. 工具栏「新建任务」建一条空白工作项；卡片详情里「复制为一条新任务」按当前单复制一份
   （描述、优先级、经办人、史诗、预估/剩余工时、计划都抄过来，描述里注明来源单）。
7. 从工作项建的会话走的是侧栏「新建对话」同一条路径，工具与权限和你手动建的会话一致；
   打开它会先看到这张单本身的上下文（编号、状态、经办人、计划、分支、目录、描述正文），
   但这只是上下文、不会替你开工——补一句要求再发送，模型才真正开始干活。
   第一次发消息之前会话日志里没有可展示的节点，所以 Host 先把工作项全文留给界面：
   新建会话时界面把它填进输入框草稿（`requestDraftInitialization`），你可以先看、改一句、
   甚至整段换掉再发。会话头右上角不再放「本次工作项」入口——那种会话本来就停在输入框那一屏，
   再放一个入口只是和草稿重复。草稿填不进去时 Host 才走 `/choerodon/session-context`
   兜底注入一次，别让模型凭空开工。

   工作项账上记着的 sessionId 会先核对会话是否真的还在（内存或持久化里任一处）：已经用
   「删除会话」清掉的会话不会再被带出来，也不会被重新打开，顺手把那条失效绑定清掉。

插件不执行 `push` / `merge` / `rebase` / `reset --hard`。

## 给模型的工具

| 工具 | 用途 |
|---|---|
| `choerodon_board` | 按泳道读看板；`mine` 默认 true，给 false 看全部；`epic`/`assignee` 按名称包含匹配（逗号分隔多个），`epicIds`/`assigneeIds` 按 id 精确筛选 |
| `choerodon_issue` | 读单个工作项详情与可流转状态，支持编号如 `PROJ-123` |
| `choerodon_comment` | 不传 `body` 读评论（含回复、附件），传 `body` 发一条评论；`markdown` 转换、`mention` 指定 @ 的人 |
| `choerodon_create_issue` | 建工作项；给 `copyFrom` 就是按现有单复制一份 |
| `choerodon_estimate` | 改原始预估 / 剩余预估工时（小时） |
| `choerodon_worklog` | 登记或查看工作项的工时日志；给 `workTime` 就是登记，不给读流水与合计 |
| `choerodon_activity` | 读操作记录（谁改了什么字段、从什么改成什么），并单独列出经办人变更 |
| `choerodon_inbox` | 站内未读数 + 「新分给我的任务」；`acknowledge: true` 把当前这批并入已知、角标清零 |
| `choerodon_update` | 改状态（必须在可流转状态里，如 `开发中`、`待测试`、`已完成`），或把经办人改成姓名 / 工号 / 用户 id / me，`clearAssignee` 清空 |
| `choerodon_search` | 按关键字搜工作项（概要/正文匹配），可只看我的，带分页 |
| `choerodon_attachment_url` | 把附件换成可直接下载的临时地址（私有桶直链会 403，这个走平台换签名） |
| `choerodon_delete_issue` | 永久删除工作项；必须传 `confirm: true`，否则拒绝并说明后果 |
| `choerodon_dict` | 读项目字典：模块、标签、冲刺、可用关联类型、工作项类型（各自单独兜底，取不到记进 errors） |
| `choerodon_update_fields` | 改描述/概要/计划起止/预估/史诗/冲刺/模块/标签/报告人，带乐观锁并回读核对 |
| `choerodon_change_type` | 转换工作项类型；平台接口不可用时返回 `available:false` 与可执行说明，不抛异常 |
| `choerodon_worktree` | 按工作项建分支与 worktree，返回可用目录 |

## 状态文件

`$DSH_HOME/choerodon-harness/state.json`（权限 0600），存登录凭据、设备身份与最近工作项。
换机器时装完插件要重新登录，不要把这份 state.json 拷过去。

## 限制

- 猪齿鱼的模型端点是会话级的（路径带 `conversations/{id}`），所以每个「组织 + 项目」会复用一个
  代理会话，它会出现在猪齿鱼网页端的会话列表里。登录走 OAuth 隐式流，没有 refresh token，过期要重登。
- **工时**：分两层。工作项上的「原始预估 / 剩余预估」是汇总字段；「工时日志」是流水，走敏捷服务的
  `/work_log`，插件两套都支持。改剩余预估时平台会同步把剩余时间对齐到原始预估，再单独写剩余值才生效。
- **新任务角标**：插件每 60 秒查一次「经办人是我、且不在上次基线里」的工作项，侧栏行尾显示 `n`，
  面板顶部给一条带编号的提示。基线覆盖我名下全部工作项（最多 1000 条），所以别人把老单改派给我
  也会被算成新任务；数字会随确认而下降，这是「有新任务」而不是「历史未读」。
- **站内消息未读**：走 `hmsg/v1/{organizationId}/messages/user/count` 与 `read-flag`，与网页右上角铃铛同源；
  该服务未安装时按 0 处理，不阻断其它功能。
- **操作记录**：走 `GET /agile/v1/projects/{p}/data_log?issueId=`（网页端「操作记录」页同一接口）。
  一次提交会产生多行字段变更，插件按「同一人、同一秒」合并成一条事件；
  `assignee` 变更单独置顶，显示成「某人 把经办人从 X → Y」。
  描述与评论是两层转义的富文本，插件折成纯文本后才展示，@提及会还原成「@姓名」。
- **界面**：样式是插件自带 CSS，颜色全部走 DSH 主题变量，深浅色自动跟随；不引任何 UI 库或外部资源。
- **删除**：工作项删除可用——`DELETE /agile/v1/projects/{p}/issues/{issueId}` 返回 204 并真的删掉，
  不需要额外的 `source` 参数。因为不可撤销，插件包成 `choerodon_delete_issue` 且强制要求 `confirm: true`。
  工时日志的删除也可用；评论删除没有提供，回网页删。
- **评论 @ 人**：`mentionList` 的每一项除了 `userId` 还必须有 `targetId`，只给 `userId` 会被
  `error.IssueCommentMention.targetIdNull` 挡回来；插件已经按这个形状拼好，正文里的 `@姓名` 会转成提及标签。
- 经办人候选来自 `cbase/choerodon/v1/projects/{p}/users/search`（一次可取 1000 条），
  比看板采样全；接口不可用时退回最近 200 条工作项上出现过的经办人。
- 优先级列表接口（`priority/list`）对该账号返回 404，只能用 `priority/default`，
  所以新建任务时优先级只有一个默认项。
- **搜索**走工作项列表的内容匹配，不是独立搜索接口：关键字的字段码是 `content`、类型 `input`、
  值必须放 `value.valueStr`。用 `summary`/`value`/`valueIdList` 都会被「数据校验不通过」挡回来，
  这几种形状都实测过。`issues/search` 接口本身返回程序错误，POST 是 403。
- **模块与标签**的关系字段名是 `componentIssueRelVOList` / `labelIssueRelVOList`（单数 VO + List）。
  写成 `...VOS` 时创建会静默忽略、更新会以「更新对象属性，没有此属性」整单失败。
- **改字段**走 `PUT /issues` 的部分更新，请求体里不能带 `projectId`，否则整单被拒。
  改原始预估时平台会把剩余预估一起对齐，所以两个都改必须分两次提交。
- **模块目录**用 `GET /component`（26 个）；`component/query_all` 在本环境固定报程序错误。
- **冲刺目录**没有可用接口（`sprint/names` 全系报程序错误），只能从工作项上的
  `activeSprint` / `issueSprintVOS` 反查，所以只列「最近工作项上出现过的冲刺」。
- **关联类型**没有可用目录接口（`issue_link_types` 403），同样从已有关联里收集。
- **类型转换**在当前环境不可用：`PUT /issues/update_type` 返回权限不符，`POST` 报程序错误，
  改成 `PUT /issues` 带 `issueTypeId` 会被「没有此属性」拒绝。工具因此返回
  `available:false` 并附服务端原话，不假装成功。
- **附件在服务端的私有 OBS 桶里**（桶名按租户分配，对象键 `agile-service/<租户>/<桶域>/<散列>/<文件名>`），
  匿名直链 403。**下载要先换签名地址**：
  `GET /hfle/v1/files/redirect-url?bucketName=private&url=<附件原始地址>` 返回 302，
  `Location` 就是带 `AccessKeyId/Expires/Signature` 的 OBS 地址，跟随即得原文件。
  三个要点都是实测出来的：`bucketName` 必须是 `private`（写 `agile-service` 会被改写成别的桶域名）；
  路径是连字符的 `redirect-url`，下划线 `redirect_url` 返回 404 权限不符；
  `url` 参数必须是附件元数据里的原始 OBS 地址，传 `fileKey` 会 `NoSuchKey`。
  插件把它包成 `/attachment/url` 与 `choerodon_attachment_url`，面板点附件名或「下载」即开新窗口下载。
- **删除工作项可以用**：`DELETE /agile/v1/projects/{p}/issues/{issueId}` 返回 204 并真的删掉（之后详情 404），
  不需要额外的 `source` 参数。三种写法（无参 / `?source=agile` / `?source=backlog`）都验证过。
  偶发 `source cannot be null` 是平台校验抖动，重试即可。早先「删不掉、要 source」的结论是错的。
  因为不可撤销，工具层强制要求 `confirm: true`。

## 改完代码后必须重启 DSH

插件在开发机上常用 Junction / link 指向源码目录：

- `client.js` 改完刷新页面即可（浏览器每次从磁盘重读）；
- `index.js` 是 Host 半区，**只在进程启动时加载一次**，改完必须重启 DSH。

只刷新页面不重启，会出现「界面是新的、接口是旧的」：登记工时 404、操作记录打不开、新任务角标不出现。
插件会自动识别这种状态并在面板顶部提示「插件版本不匹配」，接口 404 也会直接说明要重启。

核对方法：`GET /choerodon/state` 返回的 `host.features` 含 `worklog`、`activity`、`inbox` 即表示新宿主已生效。
## 从通知跳转的边界

「有新任务」里的每条都能点开对应工作项。点进去时如果单已经不在了（被删、没权限），
面板顶部会明确说「这张工作项已经没了」并给刷新入口，不会开一个空抽屉；
如果单已经改派给别人，详情照常能看，但会提示「已不在你名下、关掉后要切到「全部」才找得到」。
## v0.9.1 新增

- 建会话时的工作项全文改由**输入框草稿**承载：走 `conversation.input.requestDraftInitialization` 填进去，
  人可以先看、改一句甚至整段换掉再发；建会话那一步不再由 Host inject 一条用户消息，
  模型不会在你按下发送之前先看到任务。
- 界面填不进去时（会话不在前台、输入框正在提交）才调 `/choerodon/session-context` 兜底注入一次；
  `deliverKickoff` 幂等，重复调用不会重复注入，失败返回原因而不是假装成功。
- `HOST_VERSION` 对齐 `package.json`，面板「插件版本不匹配」里显示的宿主版本不再落后一格。

## v0.9.0 新增

- **删除工作项**：`choerodon_delete_issue`，强制 `confirm: true`，删完回读确认。

- **附件下载真的能用了**：`/hfle/v1/files/redirect-url?bucketName=private` 换 OBS 预签名地址，
  面板点附件名或「下载」直接开新窗口取原文件；新增工具 `choerodon_attachment_url`。
  实测 141732 字节的 PNG 与附件元数据 `size` 完全一致。
- 附件行显示文件大小；`choerodon_issue` 的 attachments 补 `size` 与 `fileType`。
- 更正两条旧结论：**删除工作项可用**（`DELETE /issues/{id}` 返回 204，不需要 `source`）；
  `hfle/files/download` 那条路走不通，正确入口是 `redirect-url`。

## v0.8.0 新增

- 工具栏**搜索**：按概要/正文匹配，回车执行、Esc 清空，命中清单可逐条点开。
- 新建/复制弹窗补**模块、冲刺、报告人**（数据来自 `/dict`，取不到就不挡建单）。
- 新增四个模型工具：`choerodon_search`、`choerodon_dict`、`choerodon_update_fields`、`choerodon_change_type`。
- 修 `issueTypes()` 被重复定义覆盖、返回字段叫 `code` 的 bug —— 建单的 `typeCode` 之前实际是 `undefined`。
- 修 `createIssue` 里残留的 `parentId`（平台字段是 `parentIssueId`，传错会被静默忽略）。
- **看板状态集合补全**：平台没有状态目录接口，状态只能从工作项反推，采样多少都会漏低频状态。
  现在快路径先用累积缓存立刻出泳道，后台再全量扫描，通过 **Σ(各状态 count) == 工作项总数** 这条硬判据才算完整，
  补全后前端自动重拉一次。实测 25 个状态合计 123053，与平台总数一致。
- 修了三个把泳道弄丢的 bug：返回值数组被队列 `shift()` 抽干导致第二次打开空看板；
  `force` 刷新丢掉累积底稿；「最近 200 条状态分布」的跳过逻辑把 `DEV-已完成`（594 条）误判成 0。
- 附件下载走平台预签名地址（见上），不再是只能「复制文件名」的降级方案。

## v0.7.0 新增

- 详情抽屉扩到**五个页签**：详情 / 依赖与关联 / 工时 / 评论 / 操作记录。
- 详情页可以直接**传附件、删附件**（点文件名在新窗口打开）。
- 「依赖与关联」页：**子任务**（一行输入回车即建，带字数统计和确定/取消）、
  **关联工作项**（按复制/被复制自动分组，编号可点开）、模块与版本。
- 新建/复制任务弹窗支持**先选附件**，提交时随建单一起传上去；计划时间换成浏览器自带的
  日期时间选择器，不用手敲格式。
- 复制任务拆成两个按钮：**复制这条任务**（留在看板）/ **复制并打开**（建完直接开详情）。
- 「有新任务」改成**弹窗列表**：横幅只报数，点「查看列表」开弹窗，弹窗内可搜索、可滚，
  点任意一条会关掉弹窗并打开那条工作项的详情，没点「全部已知」之前可以接着点别的。