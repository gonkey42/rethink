import { test } from 'node:test'
import assert from 'node:assert/strict'
import TLVDevice from '@/cloud/devices/tlv_device'
import * as TLV from '@/util/tlv'
import type { DeviceDiscovery } from '@/cloud/homeassistant'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'

const DEVICE_ID = 'test-id'
function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, { modelId: 'X', modelName: 'X' })
    const dev = new TLVDevice(ha.asConnection(), thinq)
    // Stop the cap-retry interval set up in the constructor so the test process can exit cleanly.
    if (dev.query_caps_timeout) {
        clearInterval(dev.query_caps_timeout)
        dev.query_caps_timeout = undefined
    }
    // addField writes into config.components[comp], so seed the comp entries we use.
    const config = {
        components: { sensor: {}, c: {} },
    } as unknown as DeviceDiscovery
    // Constructor calls queryCaps which puts a packet in the outbox; clear so each test starts fresh.
    thinq.resetRecorder()
    return { ha, thinq, dev, config }
}

test('processData ignores frames that do not match magic prefix', () => {
    const { ha, thinq } = makeDevice()
    thinq.emit('data', buf('00112233445566778899AABBCC'))

    assert.equal(Object.entries(ha.devices[DEVICE_ID]?.properties ?? {}).length, 0) // nothing published
})

test('unknown TLV id is stored in raw_clip_state but not published', () => {
    const { ha, dev } = makeDevice()
    dev.processKeyValue(0x999, 42)
    assert.equal(dev.raw_clip_state[0x999], 42)

    assert.equal(Object.entries(ha.devices[DEVICE_ID]?.properties ?? {}).length, 0) // nothing published
})

test('read_xform returning undefined discards', () => {
    const { ha, dev, config } = makeDevice()
    dev.addField(config, {
        id: 0x100,
        name: 'foo',
        comp: 'sensor',
        read_xform: () => undefined,
    })
    dev.processKeyValue(0x100, 7)
    assert.equal(dev.raw_clip_state[0x100], 7)

    assert.equal(Object.entries(ha.devices[DEVICE_ID]?.properties ?? {}).length, 0) // nothing published
})

test('read_callback returning false suppresses publish', () => {
    const { ha, dev, config } = makeDevice()
    let callbackArg: unknown
    dev.addField(config, {
        id: 0x101,
        name: 'foo',
        comp: 'sensor',
        read_xform: (v) => v + 1,
        read_callback: (v) => {
            callbackArg = v
            return false
        },
    })
    dev.processKeyValue(0x101, 5)
    assert.equal(callbackArg, 6)
    assert.equal(Object.entries(ha.devices[DEVICE_ID]?.properties ?? {}).length, 0) // nothing published
})

test('read_callback returning true allows publish', () => {
    const { ha, dev, config } = makeDevice()
    dev.addField(config, {
        id: 0x102,
        name: 'foo',
        comp: 'sensor',
        read_callback: () => true,
    })
    dev.processKeyValue(0x102, 9)
    assert.equal(ha.devices[DEVICE_ID]?.properties['sensor-foo'], 9)
})

test('readable: false suppresses publish but still updates raw_clip_state', () => {
    const { ha, dev, config } = makeDevice()
    dev.addField(config, {
        id: 0x103,
        name: 'foo',
        comp: 'sensor',
        readable: false,
    })
    dev.processKeyValue(0x103, 11)
    assert.equal(dev.raw_clip_state[0x103], 11)
    assert.equal(Object.entries(ha.devices[DEVICE_ID]?.properties ?? {}).length, 0) // nothing published
})

test('writable: false rejects setProperty and emits no packet', (t) => {
    const { thinq, dev, config } = makeDevice()
    dev.addField(config, {
        id: 0x104,
        name: 'foo',
        comp: 'sensor',
        writable: false,
    })
    dev.setProperty('sensor-foo', '1')
    assert.equal(thinq.outbox.length, 0)
})

test('setProperty with write_callback returning false suppresses send', () => {
    const { thinq, dev, config } = makeDevice()
    dev.addField(config, {
        id: 0x105,
        name: 'foo',
        comp: 'sensor',
        write_xform: (v) => Number(v),
        write_callback: () => false,
    })
    dev.setProperty('sensor-foo', '7')
    // Even though write_callback returned false, raw_clip_state should still be updated
    // - but no packet should be sent.
    assert.equal(thinq.outbox.length, 0)
})

test('setProperty with write_attach as array sends additional TLVs', () => {
    const { thinq, dev, config } = makeDevice()
    dev.addField(config, {
        id: 0x200,
        name: 'a',
        comp: 'c',
        write_xform: (v) => Number(v),
        write_attach: [0x201],
    })
    // Pre-seed the attached field so its current value is included
    dev.raw_clip_state[0x201] = 9
    dev.setProperty('c-a', '3')
    assert.equal(thinq.outbox.length, 1)
    // The packet should encode TLV t=0x200 v=3 followed by t=0x201 v=9.
    // Frame body byte 10 = TLV length. With both TLVs at l=0, length = 4.
    const out = thinq.outbox[0]
    const tlv = TLV.parse(out.subarray(11, out.length - 2))
    assert.equal(tlv[0].t, 0x200)
    assert.equal(tlv[0].v, 3)
    assert.equal(tlv[1].t, 0x201)
    assert.equal(tlv[1].v, 9)
})

test('same TLV id can publish to multiple HA properties', () => {
    const { ha, dev, config } = makeDevice()
    config.components.climate = {
        platform: 'climate',
        unique_id: '$deviceid-climate',
        name: null,
    }
    config.components.room_temperature = {
        platform: 'sensor',
        unique_id: '$deviceid-room_temperature',
        name: 'Room temperature',
    }

    dev.addField(config, {
        id: 0x1fd,
        name: 'current_temperature',
        comp: 'climate',
        state_topic: 'topic',
        writable: false,
        read_xform: (raw) => raw / 2,
    })
    dev.addField(config, {
        id: 0x1fd,
        name: '',
        comp: 'room_temperature',
        property: 'room_temperature',
        writable: false,
        read_xform: (raw) => raw / 2,
    })

    dev.processKeyValue(0x1fd, 45)

    assert.equal(ha.devices[DEVICE_ID]?.properties['climate-current_temperature'], 22.5)
    assert.equal(ha.devices[DEVICE_ID]?.properties.room_temperature, 22.5)
})

test('property override registers exact state and command topics without trailing dash', () => {
    const { dev, config } = makeDevice()
    config.components.exact = {
        platform: 'sensor',
        unique_id: '$deviceid-exact',
        name: 'Exact',
    }

    dev.addField(config, {
        id: 0x332,
        name: '',
        comp: 'exact',
        property: 'outside_temperature',
        writable: false,
    })

    assert.equal((config.components.exact as Record<string, unknown>).state_topic, '$this/outside_temperature')
    assert.equal(Object.hasOwn(dev.fields_by_ha, 'outside_temperature'), true)
    assert.equal(Object.hasOwn(dev.fields_by_ha, 'exact-'), false)
})
