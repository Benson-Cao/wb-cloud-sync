/**
 * 零依赖最小 WebSocket 服务端（RFC 6455 子集）
 * ---------------------------------------------------------------
 * 只实现 Relay 需要的部分：握手、单帧文本/关闭/心跳，不做扩展协商、
 * 不做分片重组（收到 FIN=0 直接按协议错误关闭）。客户端帧必须带 mask。
 *
 * 为什么不用 `ws` 包：P1 骨架要零依赖、可直接 `node --test` 跑、CI 不装包；
 * 正式实现若换成 `ws` 或 uWebSockets，只替换本文件，上层帧语义不变。
 */
import { createHash } from 'node:crypto'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const MAX_PAYLOAD = 1_048_576
const OP = { CONT: 0x0, TEXT: 0x1, BINARY: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa }

const encodeFrame = (opcode, payload) => {
  const len = payload.length
  let header
  if (len < 126) {
    header = Buffer.alloc(2)
    header[1] = len
  } else if (len < 65_536) {
    header = Buffer.alloc(4)
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  header[0] = 0x80 | opcode
  return Buffer.concat([header, payload])
}

/** 从缓冲区切一个完整帧；不完整返回 null。 */
const tryParseFrame = (buf, maxPayload = MAX_PAYLOAD) => {
  if (buf.length < 2) return null
  const fin = (buf[0] & 0x80) !== 0
  const opcode = buf[0] & 0x0f
  const masked = (buf[1] & 0x80) !== 0
  let len = buf[1] & 0x7f
  let offset = 2
  if (len === 126) {
    if (buf.length < 4) return null
    len = buf.readUInt16BE(2)
    offset = 4
  } else if (len === 127) {
    if (buf.length < 10) return null
    const big = buf.readBigUInt64BE(2)
    if (big > BigInt(maxPayload)) throw new Error('FRAME_TOO_LARGE')
    len = Number(big)
    offset = 10
  }
  if (len > maxPayload) throw new Error('FRAME_TOO_LARGE')
  let maskKey = null
  if (masked) {
    if (buf.length < offset + 4) return null
    maskKey = buf.subarray(offset, offset + 4)
    offset += 4
  }
  if (buf.length < offset + len) return null
  const payload = Buffer.from(buf.subarray(offset, offset + len))
  if (maskKey) for (let i = 0; i < len; i++) payload[i] ^= maskKey[i % 4]
  return { fin, opcode, payload, consumed: offset + len }
}

/**
 * 完成握手并返回连接对象。调用方负责先把 socket 从 http server 的
 * upgrade 事件里接过来。
 */
export function upgradeToWebSocket(req, socket, head, handlers = {}, options = {}) {
  // 帧上限可配：真机单条事件最大 421 KiB，固定 1 MiB 的天花板迟早会被长回复顶破
  const maxPayload = Math.max(1024, Number(options.maxPayload) || MAX_PAYLOAD)
  const key = req.headers['sec-websocket-key']
  if (!key || req.headers.upgrade?.toLowerCase() !== 'websocket') {
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
    return null
  }
  const accept = createHash('sha1').update(key + GUID).digest('base64')
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '', '',
  ].join('\r\n'))

  let open = true
  let notified = false
  let buffer = Buffer.alloc(0)
  /**
   * onClose 只通知一次，且**服务端主动关也要通知**。
   * 之前只在 socket 'close' 里调，而 conn.close() 先把 open 置 false，
   * 于是 onEnd 直接 return —— 设备一直留在 CP 的「在线」窗口里，
   * 手机请求被投进降级队列干等 10s。超限 1009、吊销、server stopping 都踩这条路径。
   */
  const notifyClose = () => {
    if (notified) return
    notified = true
    handlers.onClose?.()
  }

  const conn = {
    isOpen: () => open,
    sendText(text) {
      if (!open) return false
      socket.write(encodeFrame(OP.TEXT, Buffer.from(String(text), 'utf8')))
      return true
    },
    sendJson(obj) { return conn.sendText(JSON.stringify(obj)) },
    ping() { if (open) socket.write(encodeFrame(OP.PING, Buffer.alloc(0))) },
    close(code = 1000, reason = '') {
      if (!open) return
      open = false
      const payload = Buffer.alloc(2 + Buffer.byteLength(reason))
      payload.writeUInt16BE(code, 0)
      payload.write(reason, 2)
      try { socket.write(encodeFrame(OP.CLOSE, payload)) } catch { /* 对端已断 */ }
      socket.end()
      notifyClose()
    },
  }

  const handleFrame = (frame) => {
    if (!frame.fin) return conn.close(1003, 'fragmentation unsupported')
    if (frame.opcode === OP.CLOSE) { open = false; try { socket.end() } catch { /* 已关 */ } notifyClose(); return }
    if (frame.opcode === OP.PING) { if (open) socket.write(encodeFrame(OP.PONG, frame.payload)); return }
    if (frame.opcode === OP.PONG) return
    if (frame.opcode === OP.TEXT) return handlers.onMessage?.(frame.payload.toString('utf8'))
    if (frame.opcode === OP.BINARY) return handlers.onMessage?.(frame.payload.toString('utf8'))
    return conn.close(1003, 'unsupported opcode')
  }

  const onData = (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    try {
      for (;;) {
        const frame = tryParseFrame(buffer, maxPayload)
        if (!frame) return
        buffer = buffer.subarray(frame.consumed)
        handleFrame(frame)
        if (!open) return
      }
    } catch {
      conn.close(1009, 'frame too large')
    }
  }

  const onEnd = () => {
    open = false
    notifyClose()
  }

  socket.on('data', onData)
  socket.on('close', onEnd)
  socket.on('error', onEnd)
  if (head?.length) onData(head)
  return conn
}
