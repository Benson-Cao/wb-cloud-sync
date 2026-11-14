/**
 * v2.3 · S-8.5 设备公钥 pin（CP 层）· 确定性单测
 * 07 TC-9 新增指纹用例：首次信任钉住、变化即阻断（不给「提醒后继续」的口子）、
 * 收回设备即撤销凭证、重启落盘恢复（防 r15 白名单式静默丢字段）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createControlPlane } from '../src/index.js'
import { CP_SCHEMA } from '../src/persist.js'

const HOST = 'pc-tofu'
const KEY_A = 'a'.repeat(64)
const KEY_B = 'b'.repeat(64)
const T = 1_700_000_000_000

const setup = (opts = {}) => {
  const cp = createControlPlane({ now: () => T, ...opts })
  cp.upsertDevice({ deviceId: HOST, state: 'online', accountId: 'acct-1' })
  return cp
}

test('K1 首次配对钉住设备公钥指纹（大小写归一为小写）', () => {
  const cp = setup()
  const row = cp.upsertPhone({ phoneId: 'phone-tofu-1', hostId: HOST, devicePubKey: KEY_A.toUpperCase() })
  assert.equal(row.devicePubKey, KEY_A)
  assert.equal(cp.getDevice('phone-tofu-1').devicePubKey, KEY_A)
  assert.equal(row.accountId, 'acct-1')          // 同账号成员关系继承主机
})

test('K2 同指纹重配通过，令牌可正常轮换', () => {
  const cp = setup()
  cp.upsertPhone({ phoneId: 'phone-tofu-1', hostId: HOST, devicePubKey: KEY_A })
  cp.setPhoneToken('phone-tofu-1', 'token-1')
  assert.equal(cp.verifyClientToken(HOST, 'token-1').ok, true)
  cp.upsertPhone({ phoneId: 'phone-tofu-1', hostId: HOST, devicePubKey: KEY_A })
  cp.setPhoneToken('phone-tofu-1', 'token-2')
  assert.equal(cp.verifyClientToken(HOST, 'token-1').ok, false)
  assert.equal(cp.verifyClientToken(HOST, 'token-2').ok, true)
  assert.equal(cp.getDevice('phone-tofu-1').devicePubKey, KEY_A)
})

test('K3 指纹变化抛 DEVICE_KEY_MISMATCH，旧令牌与钉住值都不变', () => {
  const cp = setup()
  cp.upsertPhone({ phoneId: 'phone-tofu-1', hostId: HOST, devicePubKey: KEY_A })
  cp.setPhoneToken('phone-tofu-1', 'token-1')
  assert.throws(
    () => cp.upsertPhone({ phoneId: 'phone-tofu-1', hostId: HOST, devicePubKey: KEY_B }),
    (e) => e?.code === 'DEVICE_KEY_MISMATCH',
  )
  assert.equal(cp.getDevice('phone-tofu-1').devicePubKey, KEY_A)
  assert.equal(cp.verifyClientToken(HOST, 'token-1').ok, true)
})

test('K4 已钉住后再用不带指纹的旧客户端配对：放行且保留钉住值', () => {
  const cp = setup()
  cp.upsertPhone({ phoneId: 'phone-tofu-1', hostId: HOST, devicePubKey: KEY_A })
  const row = cp.upsertPhone({ phoneId: 'phone-tofu-1', hostId: HOST })
  assert.equal(row.devicePubKey, KEY_A)
})

test('K5 非法格式指纹按「未携带」处理，不钉住也不报错', () => {
  const cp = setup()
  for (const bad of ['', 'xyz', 'a'.repeat(63), 'z'.repeat(64), 42, null, {}]) {
    const id = `phone-bad-${String(bad).length}-${typeof bad}`
    const row = cp.upsertPhone({ phoneId: id, hostId: HOST, devicePubKey: bad })
    assert.equal(row.devicePubKey, null)
  }
})

test('K6 收回设备清空钉住值，重新接纳时允许钉新指纹', () => {
  const cp = setup()
  cp.upsertPhone({ phoneId: 'phone-tofu-1', hostId: HOST, devicePubKey: KEY_A })
  cp.setPhoneToken('phone-tofu-1', 'token-1')
  const revoked = cp.revokePhone('phone-tofu-1')
  assert.equal(revoked.devicePubKey, null)
  assert.equal(revoked.tokenDigest, null)
  assert.equal(cp.verifyClientToken(HOST, 'token-1').ok, false)
  const again = cp.upsertPhone({ phoneId: 'phone-tofu-1', hostId: HOST, devicePubKey: KEY_B })
  assert.equal(again.devicePubKey, KEY_B)
  assert.equal(again.tombstone, false)
})

test('K7 落盘 hydrate 恢复钉住指纹，进程重启后守卫不失效', () => {
  const cp = setup()
  cp.upsertPhone({ phoneId: 'phone-tofu-1', hostId: HOST, devicePubKey: KEY_A })
  const snapshot = {
    schema: CP_SCHEMA,
    devices: [cp.getDevice(HOST), cp.getDevice('phone-tofu-1')],
    sessions: [],
  }
  const restored = createControlPlane({
    now: () => T,
    persist: { load: () => snapshot, save() {}, flush() {} },
  })
  assert.equal(restored.getDevice('phone-tofu-1').devicePubKey, KEY_A)
  assert.throws(
    () => restored.upsertPhone({ phoneId: 'phone-tofu-1', hostId: HOST, devicePubKey: KEY_B }),
    (e) => e?.code === 'DEVICE_KEY_MISMATCH',
  )
})

test('K8 两台手机各自钉住互不干扰', () => {
  const cp = setup()
  cp.upsertPhone({ phoneId: 'phone-tofu-1', hostId: HOST, devicePubKey: KEY_A })
  cp.upsertPhone({ phoneId: 'phone-tofu-2', hostId: HOST, devicePubKey: KEY_B })
  assert.equal(cp.getDevice('phone-tofu-1').devicePubKey, KEY_A)
  assert.equal(cp.getDevice('phone-tofu-2').devicePubKey, KEY_B)
  assert.throws(
    () => cp.upsertPhone({ phoneId: 'phone-tofu-2', hostId: HOST, devicePubKey: KEY_A }),
    (e) => e?.code === 'DEVICE_KEY_MISMATCH',
  )
})

test('K9 Host 注册报文不能改写手机已钉住的指纹', () => {
  const cp = setup()
  cp.upsertPhone({ phoneId: 'phone-tofu-1', hostId: HOST, devicePubKey: KEY_A })
  cp.upsertDevice({ deviceId: HOST, state: 'online', devicePubKey: KEY_B })
  assert.equal(cp.getDevice(HOST).devicePubKey, null)
  assert.equal(cp.getDevice('phone-tofu-1').devicePubKey, KEY_A)
})
