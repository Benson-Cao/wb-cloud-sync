/**
 * p1/client-core · 能力声明表（S-2.5 / B2）
 * ---------------------------------------------------------------
 * 「哪个档案支持哪个端点」只能由 carrier 自报，App 不得硬编码档案差异
 * （S-2.5 坑：禁止写「Relay 只支持图片」这类分支——我们自建 Relay 已补全附件）。
 *
 * 本表是**默认值**（骨架级）：真机联调时按官方 web 实测校准，或在创建 carrier
 * 时用 `allowedEndpoints` / `supportsUplink` 注入覆盖。能力差异一旦调整，
 * 只改这里或 carrier 构造参数，上层 watch/call 序列不变（S-2.4 验收）。
 *
 * 说明：
 *   - `relay`：协议端点全量（r3 fileUploads / r5 审批转发 / r6 产物索引 / r8 反向补读
 *     都经 Relay 反代，Host 插件已实现）。
 *   - `local` / `ssh`：直连官方 dsh web——官方 web 自己提供对话与上传；骨架期先按
 *     同一端点集声明（官方 web 的 HTTP API 形态由 App 壳注入 `pathOf` 校准），
 *     未校准前不得声称支撑之外的端点。
 */

import { RELAY_ENDPOINTS } from './carrier.js'

export const CAPABILITY_TABLE = Object.freeze({
  relay: Object.freeze({
    supportsUplink: true,
    endpoints: RELAY_ENDPOINTS,
  }),
  local: Object.freeze({
    supportsUplink: true,
    endpoints: Object.freeze(['session/prompt', 'session/follow', 'session/backfill', 'fileUploads/upload']),
  }),
  ssh: Object.freeze({
    supportsUplink: true,
    endpoints: Object.freeze(['session/prompt', 'session/follow', 'session/backfill', 'fileUploads/upload']),
  }),
})