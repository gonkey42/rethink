import RAC_056905_WW from './RAC_056905_WW'
import { Device as Thinq2Device } from '../thinq2/device'
import { DeviceDiscovery, type Connection } from '../homeassistant'
import { type Metadata } from '../thinq'
import { racAirTemp } from '@/util/ac_tables'

const DENIED_RAC_COMPONENTS = new Set([
    'error',
    'capacity',
    'eev',
    'pipeintemp',
    'pipeouttemp',
    'oduhextemp',
    'oduairtemp',
    'energy_current',
    'autodry',
    'autodryremain',
    'filterused',
    'filterlife',
    'changeddate',
    'filterreset',
])

export default class HAL_LW1022FVSM extends RAC_056905_WW {
    constructor(HA: Connection, thinq: Thinq2Device, meta: Metadata) {
        super(HA, thinq, meta)
    }

    protected override allowRACComponent(component: string) {
        return !DENIED_RAC_COMPONENTS.has(component)
    }

    protected override addModelSpecificComponents(config: DeviceDiscovery) {
        this.addRoomTemperatureSensor(config)
        this.addEstimatedPowerSensor(config)
        this.addOutsideTemperatureSensor(config)
    }

    private addRoomTemperatureSensor(config: DeviceDiscovery) {
        if (this.raw_clip_state[0x1fd] == null) return

        const component = {
            platform: 'sensor',
            unique_id: '$deviceid-room_temperature',
            state_topic: '$this/room_temperature',
            name: 'Room temperature',
            device_class: 'temperature',
            unit_of_measurement: '°C',
            state_class: 'measurement',
            suggested_display_precision: 1,
        }
        config.components.room_temperature = component

        this.addField(config, {
            id: 0x1fd,
            name: '',
            comp: 'room_temperature',
            property: 'room_temperature',
            writable: false,
            read_xform: (raw) => raw / 2,
        })
    }

    private addEstimatedPowerSensor(config: DeviceDiscovery) {
        if (this.raw_clip_state[0x2b3] == null) return

        const component = {
            platform: 'sensor',
            unique_id: '$deviceid-estimated_power',
            state_topic: '$this/estimated_power',
            name: 'Estimated power',
            device_class: 'power',
            unit_of_measurement: 'W',
            state_class: 'measurement',
            suggested_display_precision: 0,
        }
        config.components.estimated_power = component

        this.addField(config, {
            id: 0x2b3,
            name: '',
            comp: 'estimated_power',
            property: 'estimated_power',
            writable: false,
            read_xform: (raw) => Math.max(5, raw - 60),
        })
    }

    private addOutsideTemperatureSensor(config: DeviceDiscovery) {
        if (this.raw_clip_state[0x332] == null) return

        const component = {
            platform: 'sensor',
            unique_id: '$deviceid-outside_temperature',
            state_topic: '$this/outside_temperature',
            name: 'Outside temperature',
            device_class: 'temperature',
            unit_of_measurement: '°C',
            state_class: 'measurement',
            suggested_display_precision: 1,
        }
        config.components.outside_temperature = component

        this.addField(config, {
            id: 0x332,
            name: '',
            comp: 'outside_temperature',
            property: 'outside_temperature',
            writable: false,
            read_xform: (raw) => racAirTemp[255 - raw],
        })
    }
}
