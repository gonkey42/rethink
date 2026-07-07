import { describe, test } from 'node:test'
import assert from 'node:assert/strict'
import Bridge from '@/cloud/ha_bridge'
import HAL_LW1022FVSM from '@/cloud/devices/HAL_LW1022FVSM'
import RAC_056905_WW from '@/cloud/devices/RAC_056905_WW'
import type { Metadata } from '@/cloud/thinq'
import { MockHAConnection, MockThinq2Device, buf } from '@/tests/helpers/mocks'
import { enableMockTimers, tickMockTimers } from '@/tests/helpers/timers'

const DEVICE_ID = 'test-id'
const MODEL_ID = 'WIN_056905_WW'
const META: Metadata = { modelId: MODEL_ID, modelName: 'WIN_056905_WW', swVersion: '352200' }

const CAPS_RESPONSE_HEX =
    '000004000000A702016A51' +
    'B009B0600107B09054B0C1B103B300B340B4E05016B55060B6A003E5B6F0352200B85020B8903C' +
    'B8D020B9103CBC600201BD30080000BD47B5C0B61020B642B5C1B600B642B5C2B600B642B5C8B600B6427811'
const VALUES_RESPONSE_HEX =
    '000004000000A702041643' +
    '7E427DC17E827F502D7F90238180C8C08340868086C08700884089408A008A50628A808C808CC0' +
    'ACD032D550F9D590FACAD086CB1086CB8CCBC0CC00CC90851B00C0C03967'

function makeDevice() {
    const ha = new MockHAConnection()
    const thinq = new MockThinq2Device(DEVICE_ID, META)
    const dev = new HAL_LW1022FVSM(ha.asConnection(), thinq, META)
    ha.on('setProperty', (id: string, prop: string, value: string) => {
        dev.setProperty(prop, value)
    })
    return { ha, thinq, dev }
}

function buildReadyDevice(t: import('node:test').TestContext) {
    enableMockTimers(t)
    const { ha, thinq, dev } = makeDevice()
    thinq.resetRecorder()

    thinq.emit('data', buf(CAPS_RESPONSE_HEX))
    thinq.emit('data', buf(VALUES_RESPONSE_HEX))
    tickMockTimers(t, 6000)
    thinq.resetRecorder()
    return { ha, thinq, dev }
}

function buildRawConfiguredDevice(
    t: import('node:test').TestContext,
    raw: Record<number, number>,
    beforeConfig?: (dev: HAL_LW1022FVSM) => void,
) {
    enableMockTimers(t)
    const { ha, thinq, dev } = makeDevice()

    if (dev.query_caps_timeout) {
        clearInterval(dev.query_caps_timeout)
        dev.query_caps_timeout = undefined
    }

    dev.raw_clip_state = { ...raw }
    if (beforeConfig) beforeConfig(dev)
    dev.initMakeSetConfig()
    thinq.resetRecorder()
    return { ha, thinq, dev }
}

function components(ha: MockHAConnection) {
    return ha.devices[DEVICE_ID].config!.components as Record<string, Record<string, unknown>>
}

describe('HAL_LW1022FVSM fork mapper', () => {
    test('ha_bridge routes WIN_056905_WW to the fork mapper over RAC', () => {
        const ha = new MockHAConnection()
        const thinq = new MockThinq2Device(DEVICE_ID, META)
        const bridge = new Bridge(ha.asConnection())

        try {
            bridge.newDevice(thinq)

            const mapped = bridge.haDevices.get(DEVICE_ID)
            assert.ok(mapped instanceof HAL_LW1022FVSM)
            assert.ok(mapped instanceof RAC_056905_WW)
        } finally {
            bridge.haDevices.get(DEVICE_ID)?.drop()
        }
    })

    test('publishes exactly the three V1 normal sensor discovery components from fixture TLVs', (t) => {
        const { ha, dev } = buildReadyDevice(t)

        try {
            const c = components(ha)

            assert.equal(c.room_temperature.platform, 'sensor')
            assert.equal(c.room_temperature.name, 'Room temperature')
            assert.equal(c.room_temperature.unique_id, '$deviceid-room_temperature')
            assert.equal(c.room_temperature.state_topic, '$this/room_temperature')
            assert.equal(c.room_temperature.device_class, 'temperature')
            assert.equal(c.room_temperature.unit_of_measurement, '°C')
            assert.equal(c.room_temperature.state_class, 'measurement')
            assert.equal(c.room_temperature.suggested_display_precision, 1)
            assert.equal(Object.hasOwn(c.room_temperature, 'entity_category'), false)

            assert.equal(c.estimated_power.platform, 'sensor')
            assert.equal(c.estimated_power.name, 'Estimated power')
            assert.equal(c.estimated_power.unique_id, '$deviceid-estimated_power')
            assert.equal(c.estimated_power.state_topic, '$this/estimated_power')
            assert.equal(c.estimated_power.device_class, 'power')
            assert.equal(c.estimated_power.unit_of_measurement, 'W')
            assert.equal(c.estimated_power.state_class, 'measurement')
            assert.equal(c.estimated_power.suggested_display_precision, 0)
            assert.equal(Object.hasOwn(c.estimated_power, 'entity_category'), false)

            assert.equal(c.outside_temperature.platform, 'sensor')
            assert.equal(c.outside_temperature.name, 'Outside temperature')
            assert.equal(c.outside_temperature.unique_id, '$deviceid-outside_temperature')
            assert.equal(c.outside_temperature.state_topic, '$this/outside_temperature')
            assert.equal(c.outside_temperature.device_class, 'temperature')
            assert.equal(c.outside_temperature.unit_of_measurement, '°C')
            assert.equal(c.outside_temperature.state_class, 'measurement')
            assert.equal(c.outside_temperature.suggested_display_precision, 1)
            assert.equal(Object.hasOwn(c.outside_temperature, 'entity_category'), false)
        } finally {
            dev.drop()
        }
    })

    test('keeps existing availability model on V1 discovery config', (t) => {
        const { ha, dev } = buildReadyDevice(t)

        try {
            const config = ha.devices[DEVICE_ID].config!

            assert.deepEqual(config.availability, [{ topic: '$this/availability' }, { topic: '$rethink/availability' }])
            assert.equal(config.availability_mode, 'all')
        } finally {
            dev.drop()
        }
    })
})
