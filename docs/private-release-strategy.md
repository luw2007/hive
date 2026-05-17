# 私有仓库与发版策略

这份文档记录 Hive 为什么拆成公开仓库和私有仓库，以及后续 npm 包应该从哪里构建、两个仓库如何协作。

最后更新：2026-05-17。

## 仓库与包地址

| 用途 | 地址 | 说明 |
|---|---|---|
| 公开仓库 | `https://github.com/tt-a1i/hive` | 面向外部用户的公开基础版、README、issue、项目主页和信任入口。 |
| 私有仓库 | `https://github.com/tt-a1i/hive-private` | 真实产品开发线，承载私有/商业能力，并作为后续 npm 发版源。 |
| npm 包 | `https://www.npmjs.com/package/@tt-a1i/hive` | 用户安装入口。后续包含私有产品能力的版本应从私有仓库构建。 |

SSH remote：

```sh
git@github.com:tt-a1i/hive.git
git@github.com:tt-a1i/hive-private.git
```

## 为什么要有私有仓库

Hive 当前公开版本已经足够完整，可以展示产品方向、建立用户信任，也方便朋友或早期用户安装体验。但后续一些能力不适合继续把完整源码和开发历史同步到公开 GitHub，例如：

- 更完整的 Workspace 终端能力。
- 多 tab、终端 UX、商业化工作流等高级功能。
- 容易被直接复制的实现细节和演进历史。

我们的目标不是隐藏 Hive 的产品形态。公开仓库仍然应该清楚说明 Hive 是一个本地优先、浏览器运行、多 CLI agent 协作的工作台。真正要控制的是：不要把每一步实现细节、完整源码历史和最新产品能力都公开出去。

需要明确边界：npm 包本身可以被下载和解包查看。私有仓库保护的是 Git 历史、review 上下文、完整源码树和产品迭代节奏；它不能让已经发布到 npm 的 JavaScript 变成秘密。压缩、去掉 source map 只能增加复制成本，不是安全边界。

## 两个仓库的职责

### 公开仓库：`tt-a1i/hive`

公开仓库保留为项目门面：

- README、安装方式、基础文档。
- 外部 issue 和支持入口。
- 足够好的公开基础版。
- 可公开的安全说明和 release notes。
- npm package 的 `repository` 可以继续指向这里，让用户有稳定的项目主页。

默认不要再把私有功能同步到公开仓库。

适合进入公开仓库的改动：

- 文档和定位更新。
- 公开基础版的严重 bug 修复。
- 安全修复。
- 不暴露私有实现细节的小兼容修复。

### 私有仓库：`tt-a1i/hive-private`

私有仓库作为真实产品线：

- 私有/商业功能开发。
- 后续 npm release tag。
- CI、验证、打包和发布。
- 内部 release 说明、实现计划和策略文档。

从现在开始，凡是包含私有产品能力的新 npm 版本，都应该从这个仓库打包发布。

## 发版策略

默认发版链路：

```text
tt-a1i/hive-private -> GitHub Actions release workflow -> npm @tt-a1i/hive
```

公开仓库可以继续作为 npm 上展示的项目主页，但不要再把它当作所有 npm artifact 的源码来源。

## 用户安装入口不变

私有仓库只是新的构建和发布来源，不是用户安装入口。外部用户访问不了私有仓库，也不应该被引导去 clone 私有仓库。

用户安装方式保持不变：

```sh
npm install -g @tt-a1i/hive
npx @tt-a1i/hive
```

因此公开 README、官网、朋友试用文档里仍然写 npm 安装方式。需要调整的是措辞：避免让用户以为 GitHub release asset 或公开仓库源码是唯一安装来源。公开仓库负责解释产品和承接 issue；私有仓库负责构建并发布同一个 npm 包。

每次从私有仓库发版前：

1. 确认私有分支包含本次要发布的产品代码。
2. 确认私有功能没有误推到 `tt-a1i/hive`。
3. 按 `docs/release.md` 跑完整 release gate。
4. 在 `tt-a1i/hive-private` 打 tag。
5. 由私有仓库 workflow 发布 `@tt-a1i/hive`。
6. 发布后确认：

```sh
npm view @tt-a1i/hive version repository.url dist.tarball
```

如果启用 npm provenance，需要额外确认 attestation 里显示的仓库身份是否符合预期。私有 GitHub 仓库的 provenance 可能失败，也可能暴露仓库元数据。遇到冲突时必须显式决策：

- 私有构建关闭 provenance；
- 或使用单独的公开 release metadata 仓库；
- 或接受 attestation 中出现私有仓库名。

不要在 release workflow 里悄悄改变这个策略。

当前决策：私有仓库 workflow **关闭 npm provenance**。npm 目前只支持 public GitHub Actions source repository 的 provenance；私有仓库开启 `--provenance` 会在 publish 阶段被 npm 拒绝。后续如果要恢复 provenance，需要另行设计公开 release metadata 仓库或其他不会暴露私有源码的发布链路。

当前决策：publish job 使用 `ubuntu-latest`。npm publish 与 macOS 无关，私有仓库用 Ubuntu 可以避免不必要的 hosted runner 计费压力。

## 公私仓同步规则

私有仓库可以吸收公开仓库的改动：

```sh
git fetch origin
git merge origin/main
```

公开仓库只能在明确决策后接收私有仓库里的改动：

- 安全且适合公开的 bug fix 可以 cherry-pick。
- 必要时先重写或简化实现，再回推公开版。
- 不要把私有 feature commit 直接推到 `origin/main`。

拿不准时，公开仓库保守处理，产品开发继续在私有仓库推进。

## npm 包内容原则

生产包应避免不必要的源码暴露：

- 默认不发布生产 source map，除非明确为了支持排障。
- `package.json.files` 只包含运行必需产物、文档、license 和必要 assets。
- 不要把内部计划、私有策略文档、本地截图、开发临时文件打进 npm tarball。
- 压缩和混淆只能提高复制门槛，不能当作安全机制。

任何真正的密钥、token、付费服务凭据、私有后端逻辑，都不能进入 npm 包。

## 每次发版检查

后续每次 release 至少确认：

- tag 来自 `tt-a1i/hive-private`。
- 公开仓库没有包含本次私有功能代码。
- `package.json.repository` 是有意设置的。
- source map 是否发布是明确决策。
- `npm pack --dry-run --json` 没有异常文件。
- npm `dist.tarball` 指向预期版本。
- 如果开启 provenance，attestation 来源符合预期。

## 当前结论

公开仓库保留为强门面和基础版，私有仓库成为真实产品线和后续 npm 更新源。这样既能保持 Hive 对外可见、可信、可安装，又能避免把最新产品实现和完整开发历史直接暴露在公开 GitHub 上。
