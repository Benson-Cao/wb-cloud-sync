/**
 * 下行端点表（协议名的**唯一落点**）
 * ---------------------------------------------------------------
 * 为什么要有这张表：
 *   DSH 客户端把连接焊在服务构造里，没有 transport 概念；我们无法换后端。
 *   但**我们自己这一侧**可以把「协议名 → 处理逻辑」收成一张表，
 *   将来若宿主开放远端 transport、或我们要按 ACP 的方法名对外，
 *   只需在这张表上加一层名字映射，而不用在 17 个 if 里逐个找。
 *
 *   ACP（Agent Client Protocol）的方法名是 `session/new`、`session/prompt`、
 *   `session/update`、`session/cancel` 这类。当前我们用的是 `session/create`、
 *   `session/follow` 等自有命名——映射关系记在 `ACP_EQUIVALENT` 里，
 *   **只做记录，不做重命名**：改名字会破坏已发布的 PWA 与协议版本，
 *   而收益只是"看起来像 ACP"。
 *
 * 每个 handler 返回 `{ status, body }`，由调用方统一发 `http/response` 帧。
 * `adapters` 是延迟读取的：index.js 会在 apply 之后补挂若干方法
 * （如 createArtifactTicket），所以这里绝不能解构取值。
 */

/**
 * 与 ACP 的对应关系（仅记录，未启用）。
 * 将来若切到 ACP 命名，把这张表接到 resolveEndpoint 上即可。
 */
export const ACP_EQUIVALENT = {
  'session/create': 'session/new',
  'session/prompt': 'session/prompt',
  'session/cancel': 'session/cancel',
  'session/follow': 'session/update',     // 语义最近：把会话增量流给你
  'session/backfill': 'session/update',   // 同上，方向相反（往前翻）
  '$events/result': 'session/request_permission', // ACP 里是应答，不是独立方法
}

export function createRoutes({ adapters, approvals, unwrap, errBody, protocol }) {
  /** adapter 调用 + 统一解包：成功取 value，失败按错误码映射状态。 */
  const call = async (promise, fallback) => unwrap(await promise, fallback)

  return {
    'session/prompt': (body) => call(adapters.submitPrompt({
      sessionId: body?.sessionId, text: body?.text, clientMsgId: body?.clientMsgId,
      // 无附件时不带该字段，保持适配器收到的参数形状与旧版一致
      ...(body?.attachments === undefined ? {} : { attachments: body.attachments }),
    }), { accepted: true }),

    'session/pin': (body) => call(adapters.setPinned({
      sessionId: body?.sessionId, pinned: body?.pinned !== false,
    }), { pinned: body?.pinned !== false }),

    'session/schedule-list': (body) => call(adapters.listSchedules({
      limit: body?.limit, offset: body?.offset,
    }), { rows: [] }),

    'session/schedule-create': (body) => call(adapters.createSchedule({
      title: body?.title, prompt: body?.prompt, afterSeconds: body?.afterSeconds, target: body?.target,
    }), {}),

    'session/schedule-run': (body) => call(adapters.runSchedule({ id: body?.id }), {}),

    'session/rename': (body) => call(adapters.renameSession({
      sessionId: body?.sessionId, title: body?.title,
    }), {}),

    // ADR-011：显式产物导出。校验在 Host，票据在 Relay；这里只回元数据 + 内存中转的字节
    'session/artifact-ticket': (body) => call(adapters.createArtifactTicket({
      sessionId: body?.sessionId, relPath: body?.path, format: body?.format,
    }), {}),

    // 归档/恢复（r12）：软移除，返回宿主给的完整归档集合
    'session/archive': (body) => call(adapters.setArchived({
      sessionId: body?.sessionId, archived: body?.archived !== false,
    }), { archived: body?.archived !== false }),

    'session/cancel': (body) => call(adapters.cancelTurn({ sessionId: body?.sessionId }), { cancelled: true }),

    'session/create': (body) => call(adapters.createSession({
      text: body?.text ?? '', cwd: body?.cwd ?? null, clientId: body?.clientId ?? null,
    }), { created: true }),

    // ADR-012：镜像只读导出（原件字节，分块）
    'session/mirror-list': () => call(adapters.mirrorList(), { rows: [] }),

    'session/mirror-file': (body) => call(adapters.mirrorFile({
      sid: body?.sid, name: body?.name, offset: body?.offset, maxBytes: body?.maxBytes,
    }), { sid: body?.sid ?? null, bytes: '', eof: true }),

    'session/follow': (body) => call(adapters.replay({
      sessionId: body?.sessionId, sinceSeq: body?.sinceSeq,
    }), { events: [] }),

    'fileUploads/upload': (body) => call(adapters.uploadAttachment({
      sessionId: body?.sessionId, data: body?.data, name: body?.name,
    }), { receiptId: null }),

    'session/backfill': (body) => call(adapters.backfill({
      sessionId: body?.sessionId, beforeSeq: body?.beforeSeq, limit: body?.limit,
      // 首屏窗口可以要得比一页大；适配器会把上限锁在 4× 页预算。
      // 只在客户端显式给时带上，避免把 bytes: undefined 透给适配器。
      ...(body?.bytes === undefined ? {} : { bytes: body.bytes }),
    }), { sessionId: body?.sessionId ?? null, events: [], hasMoreEarlier: false }),

    // 只回元数据（路径 / 描述 / seq），文件字节绝不经过 Relay（ADR-010）
    'session/artifacts': (body) => call(adapters.listArtifacts({
      sessionId: body?.sessionId,
    }), { sessionId: body?.sessionId ?? null, rows: [], count: 0, truncated: true }),

    /**
     * 手机点了「允许 / 拒绝」：先答先得，第二个人点会被这里挡掉（409 APPROVAL_GONE）。
     * 这条不走 unwrap：它要区分「参数错（400）」与「已被别人答了（409）」。
     */
    '$events/result': (body) => {
      const r = approvals.answer({ approvalId: body?.approvalId, outcome: body?.outcome })
      if (!r.ok) {
        const status = r.code === 'INVALID_OUTCOME' ? 400 : 409
        const code = r.code === 'INVALID_OUTCOME' ? 'INVALID_JSON' : 'APPROVAL_GONE'
        const msg = r.code === 'INVALID_OUTCOME'
          ? 'outcome 必须是 allowed-once / rejected / cancelled'
          : '该审批已被应答或已过期'
        return { status, body: errBody(code, msg, r.code === 'APPROVAL_GONE') }
      }
      return {
        status: 200,
        body: { ok: true, data: { approvalId: body?.approvalId, outcome: r.outcome }, protocol },
      }
    },
  }
}

/** 未知端点的统一拒绝（保持与旧实现一致的 403 语义）。 */
export const notAllowed = (endpoint, errBody) => ({
  status: 403,
  body: errBody('ENDPOINT_NOT_ALLOWED', `端点不在白名单：${endpoint}`),
})
