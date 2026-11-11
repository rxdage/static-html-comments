# static-html-comments

版本 0.2.3 · MIT

给**本机静态 HTML** 用的点击批注：在页面上点一个元素、写一句话，这句话连同它指的元素存进项目里的一个文件；Agent 读文件改稿，用一条命令写回回复，页面上那条变灰并显示回复。

![点元素写批注，Agent 用命令回写回复，页面上那条变灰并显示回复](docs/demo.gif)

它只占一小格，这一格的四个条件同时成立时才值得用它：

- **页面一个字节都不能改**。批注层是本地服务在返回 HTML 时临时插进去的，磁盘上的文件不动（交付物要原样归档、要给外部审阅时，这是硬条件）。
- **要点的是元素，不只是文字**。图、SVG、公式、空白处都能点；记录的是元素路径加相对位置。
- **每条意见要有一句回复**，并且显示在页面上那条意见旁边，而不只是“已解决”。
- **不想装别的东西**。两个 JS 文件，只要 Node 16 以上，没有任何依赖。

“在页面上批注、让 Agent 照着改”这件事本身不是新东西，下面这些项目都在做，而且多数比它成熟。

## 什么时候该用别的

以下各项是 2026-11-11 读它们各自的 README / 文档得到的，没有读源码，也没有实际安装；之后可能有变化。

| 你的情况 | 用这个 | 它和本工具的差别 |
|---|---|---|
| 页面是 React 应用，愿意接 MCP | [Agentation](https://github.com/benjitaylor/agentation) | React 18+ 组件加 MCP 服务；点元素、选文字、多选、框选；Agent 通过 MCP 读取、确认、回复、解决。功能最全，但要把组件装进应用 |
| 页面跑在 React 开发服务器上 | [@mrosseel/page-comments](https://github.com/mrosseel/page-comments) | React 组件加开发服务器中间件；点屏幕位置，带截图；批注在 `comments/comments.json`，有命令行。本工具原来也叫 page-comments，因为和它重名改了名 |
| 主要批文字，还要贴图 | [html-annotate](https://github.com/GasonW/html-annotate) | 同样不改源文件。选中文字批注，可以粘贴或上传图片；Agent 改完标为已解决。需要 Python |
| 不介意往 HTML 里加两个标签，想看“改了哪里” | [make-pages-interactive](https://github.com/paraschopra/make-pages-interactive) | 选文字、点元素、整页意见都有；Agent 改完后页面自动刷新并逐处走查改动。会向每个 HTML 注入标签（可撤销），需要 Python |
| 审阅的是别人，需要一个地址发给他们 | [pagepin](https://github.com/pagepin/pagepin) | 托管或自建服务；点元素留标记，带讨论串；Agent 通过接口取 JSON。是部署形态，不是本机文件往返 |
| 想直接在文档里改字、留指令 | [iterate-on-docs](https://github.com/jessitron/iterate-on-docs) | 指令和编辑直接写回 HTML 文件，每轮提交一次 git。会改文件本身 |
| 想在 Agent 会话里审一个网址或文档 | [Plannotator](https://docs.plannotator.ai/learn/annotate-any-web-page-or-html-file) | 在它自己的审阅界面里高亮文字、写意见，发回当前会话。不改页面，也不落成项目文件 |

本工具没有的：选中文字批注、图片和截图、框选、多人讨论串、改动走查、对 React 开发服务器的支持。

## 安装

它是一个文件夹，不需要安装步骤，也不需要 `npm install`；只要 Node 16 以上。

**直接用**：克隆或下载这个仓库（或从 [Releases](https://github.com/rxdage/static-html-comments/releases) 下载压缩包），在里面运行下面的命令。

**当技能装**：把整个文件夹放进你的 Agent 的技能目录，Agent 会按 [SKILL.md](SKILL.md) 在合适的时候启用它。它是技能（skill），不是插件（plugin）。

DeepSeek Harness（DSH），全局：

```powershell
# Windows PowerShell
New-Item -ItemType Directory -Force "$HOME\.dsh\skills" | Out-Null
git clone https://github.com/rxdage/static-html-comments "$HOME\.dsh\skills\static-html-comments"
```

```bash
# macOS / Linux
git clone https://github.com/rxdage/static-html-comments ~/.dsh/skills/static-html-comments
```

DSH，只给某个项目用（在项目根目录执行）：

```bash
git clone https://github.com/rxdage/static-html-comments .dsh/skills/static-html-comments
```

Claude Code：

```bash
git clone https://github.com/rxdage/static-html-comments ~/.claude/skills/static-html-comments
```

装 DSH 时注意三点：

- DSH 是按目录扫描发现技能的，`dsh plugin add` 装不了它。
- `SKILL.md` 必须在技能目录的第一层：`.dsh/skills/static-html-comments/SKILL.md`。解压压缩包时别多套一层文件夹，DSH 不会往更深处找。
- DSH 也会扫描 `.agents/skills`（项目里和用户目录下各一个），放那里同样有效。

装好后对 Agent 说“给这个页面开批注”或“按批注改”即可。

## 30 秒试一下

```
node static-html-comments.js demo
```

Windows 上也可以直接双击 `static-html-comments.cmd`（打开自带示例），或者把一个文件夹 / 一个 `.html` 文件拖到它上面。

浏览器打开后已经在批注模式：点页面任意位置，写一句话，回车。

## 用法

| 操作 | 怎么做 |
|---|---|
| 进出批注模式 | `Alt+C`，或点右侧边缘的“批注” |
| 写一条 | 批注模式下点想改的地方 → 写 → 回车（Shift+回车换行） |
| 不针对具体位置 | 顶栏“整页意见” |
| 改、删、标为已处理 | 点页面上的编号标记 |
| 看全部、跳到某一条 | 顶栏“列表”，点一条跳过去（跨页面也行） |
| 贴给不会读文件的对象 | 顶栏“复制全部”，得到一段 Markdown |

批注模式下页面自己的点击和拖动不响应。要点链接、切标签、翻页，先按 `Alt+C` 退出，操作完再回来。

## 给 Agent 的命令

```
node static-html-comments.js <目录 或 .html>                   起服务，打开浏览器
node static-html-comments.js list    <目录> [--all] [--json]   列出批注
node static-html-comments.js resolve <目录> <id> "回复"        标为已处理并写回复
node static-html-comments.js reopen  <目录> <id>               重新打开
```

选项：`--port 8790`（不指定时被占用会自动往后找）、`--no-open`、`--lang zh|en`。批注固定存在 `<目录>/.page-comments/`，服务和这几条命令读写的永远是同一处。

`list` 的输出长这样：

```
## /  (示例页 · 烘焙记录周报)

- [ ] `cmwc661t06tsn` 这句太长，拆成两句
  - on: "把发展时间从 90 秒拉到 110 秒以后，酸质明显变圆…"  `body > main > p:nth-of-type(2)`  (at 34%, 56% of the element; viewport 1024x768)
```

完整的 Agent 使用说明在 [SKILL.md](SKILL.md)，可以直接当技能装。

## 工作原理

1. `static-html-comments.js` 把目标目录当静态站点开在 `127.0.0.1`，返回 HTML 时在 `</body>` 前插一行 `<script src="/__pc__/client.js">`。按字节插入，页面原来是什么编码就还是什么编码。
2. `client.js` 在 Shadow DOM 里画自己的界面，和页面样式互不影响。点击时记下被点元素的 CSS 路径、点在元素内的相对位置、元素上的文字。
3. 标记贴着元素走：滚动、改窗口大小、翻页、切标签时重新定位。每次定位都在那个点上做一次命中测试：元素被隐藏、滚出视野、被裁掉，或者被抽屉、弹层、另一页盖住时，标记也隐藏。所以长页面、整屏翻页的幻灯片、带标签页和侧边抽屉的页面都能用。
4. 每次改动 POST 给本地服务，服务加锁后按“同一条取时间戳较新的”合并写盘，同时生成一份可读的 `comments.md`。
5. 页面每 10 秒和窗口重新获得焦点时拉一次，Agent 写的回复就这样回到页面上。

## 批注文件

`<目录>/.page-comments/comments.json`：

```json
{ "version": 1, "comments": [ {
  "id": "cmwc661t06tsn",
  "path": "/", "hash": "", "title": "示例页 · 烘焙记录周报",
  "sel": "body > main > p:nth-of-type(2)", "tag": "p", "rx": 0.3439, "ry": 0.5636,
  "ctx": "把发展时间从 90 秒拉到 110 秒以后，酸质明显变圆…",
  "text": "这句太长，拆成两句",
  "vw": 1024, "vh": 768,
  "status": "open", "reply": "",
  "created": "2026-11-11T13:43:02.511Z", "updated": "2026-11-11T13:43:05.204Z"
} ] }
```

整页意见的 `sel` 是 `null`。删除是打 `deleted: true` 标记。回复和状态请用 `resolve` / `reopen` 命令写，不要手改：手改而不更新 `updated`，浏览器里的旧副本会把它盖回去。

同一个文件夹里还有：`comments.md`（自动生成的可读清单）、`comments.json.bak`（上一次写入前的完好副本）、`.gitignore`（内容是 `*`，默认不让批注进版本库；想留痕就删掉它）。写入时会短暂出现 `comments.lock`，里面记着持有它的进程；只有持有者已经不在、且锁超过 10 秒，别的写入才会接管它。

**批注文件损坏时不会被覆盖。** 文件存在但是空的（0 字节、只有空白）或解析不了时，`list` / `resolve` 以退出码 2 报错，服务对读写都返回 500，页面顶栏显示“批注文件损坏”，磁盘上的文件一个字节不动。修好它、用 `.bak` 恢复、或者把它挪走，之后自动恢复正常；这期间新写的批注留在浏览器里，恢复后自动补存。

## 已知限制

- 只适用于本机静态文件。需要构建或后端渲染的页面，要对构建产物用，或者不适用。
- 文件名里带反斜杠或冒号的资源不会被提供（见“安全”）。
- 元素路径靠结构定位。页面结构大改后旧批注可能找不到原元素；会退回到按文字找，再找不到就在列表里标“原位置找不到了”，意见本身不丢。
- 没有选中文字批注，没有图片、截图和框选。
- 页面带 `script-src` 的内容安全策略（尤其是 nonce）时，插入的脚本不会执行，批注层起不来。
- 页面自己用 Shadow DOM 或 `<iframe>` 包起来的内容，只能批到外层那个元素。
- “批注模式下页面点击不响应”不是绝对的：页面如果先于批注层、在 `window` 的捕获阶段注册了点击或键盘监听，它仍会先执行。
- 单人使用，没有作者字段，没有讨论串。
- 实测环境只有 Windows 11 上的 Chrome 和 Edge。macOS、Linux、Firefox、Safari、触屏都没测。

## 安全

- 服务只绑 `127.0.0.1`，局域网里别的机器连不上。
- 只应答发给 `127.0.0.1` 或 `localhost` 的请求（检查 `Host`），别的网站不能通过把自己的域名指向本机来读你的文件夹。
- 不提供任何以 `.` 开头的文件和文件夹（`.env`、`.git/`、`.page-comments/` 等）。判断依据是路径**解析之后实际落在哪里**，不是地址怎么写：链接、Windows 联接（junction）和短文件名都先解析，落进隐藏文件夹的不给，落到目录之外的也不给。
- 地址里带反斜杠或冒号的请求一律拒绝。在 Windows 上反斜杠是路径分隔符、冒号能打开备用数据流，静态网页的地址用不到它们。
- 写接口拒绝来自其他来源的请求（检查 `Origin`）。
- 不联网，不上报，不装任何东西。

这些防护的边界，照实写：

- **“不提供隐藏文件”是按名字和路径判断的，不是按内容。** 如果文件夹里有一个名字正常的硬链接或副本指向 `.env` 的内容（例如 `mklink /H public.txt .env`），`/public.txt` 会被照常提供：它就是一个公开名字的普通文件，任何按名字拒绝的服务都分辨不出来。
- **被打开的 HTML 和服务同源。** 页面里的脚本可以读同一个文件夹里的其他非隐藏文件，也可以调用批注接口。
- 所以：**只对你信任的文件夹用它**，不要拿它去开来路不明的 HTML。
- **没有实测的两条**：Windows 的 8.3 短文件名（测试用的盘没开短名；代码用的是会展开短名的系统调用）和文件符号链接（创建需要管理员权限；只实测了目录联接）。按代码路径它们应当被同一处检查拦住，但没有端到端验证过。
- 服务跑在 80 端口的情况有代码支持，没有实测。

## 测试

```
node test/selftest.js     67 项，不需要浏览器
node test/e2e.js          29 项，用真实鼠标键盘事件驱动本机 Chrome / Edge
```

`selftest.js` 把示例复制到临时目录起服务，检查注入、编码、接口、合并规则、来源和路径防护、隐藏文件（十几种路径写法、指向隐藏文件夹和目录之外的链接）、损坏和空的批注文件、文件锁（16 个同时写入一条不丢；持有者还活着的旧锁不被接管）。

`e2e.js` 没有依赖，通过浏览器的调试协议发真实的点击和按键：点元素写批注、滚动后标记跟随、命令行回复后页面变灰、整页意见、标签页隐藏与显示、跨页跳转、损坏文件、另一个网站的页面既写不进也读不到批注、页面文件字节不变。它需要 Node 22 以上和一个 Chromium 内核浏览器，用 `CHROME_PATH` 指定浏览器。缺任何一样时它会打印 `SKIPPED (nothing was tested)` 并以 0 退出，**看到 SKIPPED 不等于跑过**；在自动化流程里加 `--require-browser`，缺了就以退出码 2 失败。

## 更新记录

- 0.2.3：没有代码变化。README 补 DSH 的安装方式，加一张操作动图。
- 0.2.2：没有功能变化。“安全”一节写明防护的边界（硬链接或副本、同源、两条未实测）；修正 80 端口下对来源的判断。第三轮评审用自己的一份页面（表格、SVG、代码块、长页面）跑通，是第二个用户的第一次反馈。
- 0.2.1：第二轮评审打穿了 0.2.0 的两处修复，这一版补上。隐藏文件：地址里用反斜杠、或经由一个名字正常的联接，仍能读到 `.env` 和隐藏文件夹；现在按解析后的真实路径判断，并拒绝带反斜杠或冒号的地址。空的批注文件：之前被当成“还没有批注”，下一次保存会覆盖它并毁掉 `.bak`；现在空文件按损坏处理。文件锁只在持有者确实不在时才被接管。`e2e.js` 加 `--require-browser`，并加了跨站写入的实测。
- 0.2.0：改名为 static-html-comments（原名 page-comments，与已有项目重名）。加 MIT 许可证。重写定位和同类对比。写入加文件锁。新增浏览器端自动化测试。
- 0.1.2：损坏的批注文件不再被当成空文件覆盖；不再提供隐藏文件，并校验 `Host`；去掉 `--out`。每次写入前留 `.bak`、自动写 `.gitignore`。
- 0.1.1：标记被别的东西盖住时隐藏；`/` 和 `/index.html` 算同一页；服务重启或批注文件被删后，开着的页面不再把旧批注写回。
- 0.1.0：第一版。

## 文件

```
static-html-comments.js     服务 + 命令行
client.js                   页面上的批注层
static-html-comments.cmd    Windows 拖放启动
SKILL.md                    给 Agent 的使用说明（技能格式）
LICENSE                     MIT
demo/                       示例页（两页，内容是编的）
test/selftest.js            服务端与命令行自测
test/e2e.js                 浏览器端自测
docs/                       动图、截图、三轮评审的记录
```
