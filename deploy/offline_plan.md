# MC1life 网络受限部署方案 (手机离线安装)

## 背景
- 用户设备无法配置 VPN, 网络访问 GitHub/minecraft.net 超时
- proot-distro v5 从 ghcr.io 拉镜像 -> 超时
- 解决: 在沙箱 (能连 GitHub) + Cloudflare Pages /dl 代理 (能连 minecraft.net) 下载全部依赖,
  打包导出给用户, 手机端完全离线安装

## 依赖清单 (已下载并验证)
| 文件 | 大小 | 来源 | 状态 |
|---|---|---|---|
| bds-1.21.90.4.zip | 66MB | minecraft.net (经 Pages /dl 代理) | ✅ CRC 通过 |
| debian-trixie-aarch64.tar.xz | 34MB | termux/proot-distro v4.29.0 release | ✅ xz 可读 |
| box64.deb (通用arm64) | 10MB | ryanfortner/box64-debs master | ✅ !<arch> 验证 |
| x86libs.tar.gz | 33MB | ptitSeb/box64 v0.4.4 | ✅ 610 文件 |
| offline_setup.sh | 5KB | 自写 (清华 apt 源 + 手动 proot) | ✅ bash -n |

## 手机端步骤
1. 解压 mc1life_offline_pack.zip 到 Termux 可访问目录 (如 ~/storage/shared/mc1life_offline/)
2. Termux 执行: bash ~/storage/shared/mc1life_offline/offline_setup.sh
3. 脚本自动: 装 proot -> 解压 rootfs -> 配清华源 -> 装 box64+x86libs -> 解压 BDS -> 生成启动脚本
4. 启动: proot 登录 Debian -> cd /root/bds && ./run.sh
5. 玩家连接: [IPv6]:19133

## 关键文件位置
- 离线包: /workspace/mc1life_offline_pack.zip (142MB, 已导出)
- 源文件: /workspace/offline_pack/
- 部署脚本: /workspace/offline_pack/offline_setup.sh

## 已知注意
- box64 需要 x86_64 系统库, x86libs bundle 提供基础库; 若 BDS 启动缺库,
  需在 Debian 内 apt 装 amd64 库 (清华源已配好): dpkg --add-architecture amd64 && apt install libc6:amd64 libstdc++6:amd64 libcurl4:amd64 libssl3:amd64
- 荣耀 8X 4GB: 建议 view-distance<=12, max-players<=8 (脚本已配)

## 排障记录 (2026-08-30)
1. curl 符号错位 (SSL_set_quic_tls_transport_params) -> apt full-upgrade 修复 (pkg 依赖 curl, 改直接 apt)
2. rootfs 顶层目录 debian-trixie-aarch64/ 嵌套 -> 解到 stage 再移入 (--strip-components 备选)
3. /dev mknod 报错 -> 正常, proot -b /dev 绑定, tar 忽略
4. Termux /tmp 只读 -> stage 目录改用 ${HOME}/.mc1life-rootfs-stage
5. rootfs 解压不完整 (tar 遇 mknod 提前退出, /usr/bin/env 缺失) -> --exclude='*/dev/*' 跳过 dev 完整解压, 校验 bin/bash+usr/bin/env
6. proot 运行时目录缺失 (can't chmod $PREFIX/usr/tmp) -> 脚本开头 mkdir -p ${PREFIX}/tmp && export TMPDIR
7. rootfs 校验不全 (漏 ld-linux) -> 增加 usr/lib/aarch64-linux-gnu/ld-linux-aarch64.so.1 检查 (trixie usr-merge 布局)
8. TMPDIR 用 $PREFIX/tmp 仍不可写 -> 改用 $HOME/.mc1life-tmp
9. mv 不匹配隐藏文件 -> shopt -s dotglob
10. 用户可能仍在跑旧脚本 (报错路径仍为 $PREFIX/tmp) -> v7: 版本号回显 + 无条件重解 + TMPDIR 硬校验 + 独立文件名 offline_setup_v7.sh (不覆盖旧文件)
11. 根因锁定: Termux proot 二进制硬编码 ${PREFIX}/tmp (忽略 TMPDIR), 该目录不存在 -> proot 启动失败 -> 连带 execve /usr/bin/env 假报错
    -> v8: mkdir -p ${PREFIX}/tmp 并硬校验可写 + proot 冒烟测试 (输出实际错误) + -b HOME/.mc1life-tmp:/tmp 绑定
12. 冒烟测试暴露真错误: execve /usr/bin/env ENOENT (非临时目录问题)
    -> 根因: mv 失败走 cp -rn 跟随 symlink 复制, usr-merge 链 (lib->usr/lib) 断裂, 加载器不可解析
    -> v9: 去掉 stage+mv, 直接 --strip-components=1 解压 + 强制重建 symlink 链 + 校验 /lib/ld-linux-aarch64.so.1 可解析
13. v9 后仍 execve ENOENT -> 判定: 手写 proot 参数/解压在荣耀8X上不可靠
    -> v10: 改用 proot-distro 官方机制: `proot-distro install <本地tar>` (绕开 ghcr.io) + `proot-distro login` (官方验证参数) + --bind 映射离线包
    -> 备选: diagnose.sh 采集 proot 各参数组合测试结果

## 突破记录 (2026-08-30 沙箱全栈验证)
14. v10 有两个 bug: ① --bind 选项放在容器名之后 (proot-distro login 语法错误, 应放前面)
    ② 冒烟测试字符串用双引号, $(uname -m) 在手机侧被提前展开
    -> v11: 修正这两点 + 增加 debs/ amd64 库离线安装 (BDS 需要 x86_64 glibc)
15. box64 需要 arm64 原生包装库: 除 x86libs bundle 外, 还需系统 arm64 库
    (libidn2/libssh2/libpsl/libkrb5/libgnutls/libldap/libgcrypt/libnghttp 等) 全部离线打包
16. **dn_expand/libresolv 问题**: trixie libldap.so.2 需要 dn_expand/res_query (在 libresolv 里),
    box64 无法从 libc 解析 -> 解法: patchelf --add-needed libresolv.so.2 预补丁 libldap-2.5.so.0
    (patched/ 目录), 换 bookworm libcurl4 (7.88, OpenSSL 3.0 无 QUIC 新符号)
17. **BDS 1.21.90.4 在沙箱完整启动成功**: box64 + amd64 库 + patched libldap
    -> "Server started." + IPv4 19132 / IPv6 19133 + UDP MCPE 响应正常
18. RCON 在沙箱受限环境未监听 (沙箱网络隔离), 手机实测; Agent 有 stdin 兜底不影响核心功能
19. Node v22.23.2 (linux-arm64) + Agent (含 node_modules + 填好凭证的 config.json) 离线打包,
    Agent 在容器内运行, 出站 WS 连 CF Worker (无需内网穿透)
    -> v12: BDS + Agent + Node 一体离线安装
