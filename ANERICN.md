# anericn 定制分支说明

本仓库 fork 自 [LibreSpark/LibreTV](https://github.com/LibreSpark/LibreTV)。定制改动都在 **`anericn` 分支**上（也是仓库的默认分支），`main` 分支保留的是 2025 年的旧版内容，没有改动。部署在 https://tv.anericn.top 。

## 定制内容：全站共享源

上游的源配置只存在各自浏览器里。这个分支增加了「设置 → 源管理 → 全站共享」：管理员可以把本机当前启用的点播源和直播源同步到服务器，所有登录用户打开站点时都会自动获得这些源，并且默认勾选。

- **同步语义**：服务器上的列表会被整体替换成本机当前启用的那一份。取消勾选某个共享源再同步，就会把它从服务器移除。涉及移除时会先弹窗确认。
- **权限**：查看需要登录，修改还要额外输入管理密码 `ADMIN_PASSWORD`。只知道访问密码 `PASSWORD` 的人不能修改。
- **存储**：数据存在 `DATA_DIR/server-sources.json`，镜像里的默认路径是 `/app/data`，用数据卷 `libretv-data` 持久化。
- **下发**：`/api/status` 只在用户登录后才把共享源并入 `defaultSources` / `defaultLiveSources`，未登录的访客看不到。客户端复用上游的「部署者预置源」逻辑。共享源的 key 按地址哈希生成（`srv_…` / `srvlive_…`），增删其他条目不会让已有源的 key 变化。
- **去重**：同步成功后，本机与共享源地址相同的点播源会被取消勾选，但不删除，旧的观看历史仍能找到来源。本机手动添加的同地址直播源会被移除，共享直播源保持启用。另外搜索时会按地址去重，同一个源只搜一次。

### 改动的文件

新增文件（上游没有，合并时不会冲突）：

- `src/lib/server-sources.ts`、`src/lib/admin-auth.ts`、`src/lib/server-sources-sync.ts`，以及各自的 `*.test.ts`
- `src/app/api/admin/sources/route.ts`（及测试）
- `src/components/server-sources-panel.tsx`
- `.github/workflows/anericn-image.yml`、`.github/workflows/anericn-upstream-sync.yml`
- `ANERICN.md`（本文件）

对上游文件只做了少量修改，代码里都用 `anericn` 注释标出：

| 文件 | 改动 |
| --- | --- |
| `src/app/api/status/route.ts` | 登录后并入共享源 |
| `src/components/auth.tsx` | 登录成功后重新拉取 `/api/status`，不再复用登录前的缓存 |
| `src/components/source-manager.tsx` | 加一个「全站共享」标签；共享源的徽章显示为「全站共享」 |
| `src/lib/store.ts` | `allLiveSources` 按地址去重 |
| `src/app/page.tsx` | 搜索时按地址对已选源去重（本机源与共享源地址相同时只搜一次） |
| `Dockerfile` / `docker-compose.yml` / `.env.example` / `.gitignore` | 数据目录、数据卷、`ADMIN_PASSWORD` |

## 镜像

推送到 `anericn` 分支后，GitHub Actions（`anericn-image`）会先跑类型检查和单测，通过后构建 `linux/amd64` 镜像：

- `ghcr.io/fatal0607/libretv:anericn`（滚动标签，始终指向最新一次构建）
- `ghcr.io/fatal0607/libretv:<版本>-anericn`，例如 `2.19.5-anericn`
- `ghcr.io/fatal0607/libretv:sha-<短提交号>`（回滚时用）

## 跟进上游更新

### 自动同步

工作流 `anericn-upstream-sync` 每天北京时间 10:30 运行一次，也可以在 Actions 页面手动触发，或者执行 `gh workflow run anericn-upstream-sync.yml --ref anericn -R Fatal0607/LibreTV`。修改这个工作流文件并推送到 `anericn` 时，它也会运行一次。它会拉取上游 `LibreSpark/LibreTV` 的 `main` 分支，尝试合并进 `anericn`，合并提交信息为 `chore: merge upstream vX.Y.Z`：

- **已经是最新**：什么也不做。
- **无冲突，且 `npm ci`、`npm run typecheck`、`npm test` 都通过**：直接推送到 `anericn`，然后显式触发 `anericn-image` 构建镜像。用 `GITHUB_TOKEN` 推送的提交不会触发 push 事件，所以需要显式触发。
- **有冲突或检查失败**：不推送 `anericn`，而是把合并结果提交到 `upstream-sync/<日期>-<上游短提交号>` 分支，再开一个 PR 到 `anericn`。PR 描述里会列出冲突文件，冲突标记原样留在分支上。同一个上游提交只开一个 PR。处理方法：在这个分支上解决冲突后，用 **merge commit** 方式合并 PR，不要用 squash。合并后推送到 `anericn` 会自动构建镜像。
- **上游改动了 `.github/workflows/` 下的文件**：`GITHUB_TOKEN` 没有推送工作流文件的权限，这时运行会直接失败并报出文件名，需要按下面的步骤手动合并。

**定时触发的前提**：GitHub 只认**默认分支**上的工作流文件里的 `schedule`，所以本 fork 的默认分支已经设为 `anericn`（Settings → General）。这只是仓库设置，`main` 的内容没有改动。

### 手动合并

```bash
git fetch upstream
git switch anericn
git merge upstream/main -m "chore: merge upstream vX.Y.Z"   # 有冲突时，基本只会出现在上表的几个文件里
npm ci && npm run typecheck && npm test
git push origin anericn        # 推送后会自动构建新镜像
```

合并上游时不要推送 `v*` 标签：上游自带的 `docker-publish.yml` 只在推送这类标签时触发。

## 服务器部署

服务器上的部署目录是 `/opt/libretv`。`.env` 里需要配置以下变量：

- `PASSWORD`：访问密码
- `ADMIN_PASSWORD`：管理密码
- `PROXY_SECRET`：内部签名密钥
- `LIBRETV_IMAGE`：要部署的镜像

更新版本的步骤：

```bash
cd /opt/libretv && docker compose pull && docker compose up -d
```
