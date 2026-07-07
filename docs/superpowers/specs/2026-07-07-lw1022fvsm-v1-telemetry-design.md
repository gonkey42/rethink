# LW1022FVSM V1 Telemetry Design

Date: 2026-07-07
Status: draft for review
Target checkout: `/Users/hal9000/Documents/Codex/2026-06-20/i/work/rethink-rac-validation-2026-07-05`
Target device: Hal's installed LG LW1022FVSM, reported by rethink as `WIN_056905_WW`

## Goal

Expose three useful AC telemetry readings from rethink as normal Home Assistant MQTT sensors. On a clean Home Assistant entity registry, the expected entity IDs are:

- `sensor.lg_air_conditioner_room_temperature`
- `sensor.lg_air_conditioner_estimated_power`
- `sensor.lg_air_conditioner_outside_temperature`

This is a fork release for Hal's installed AC, not an upstream attempt to support every `WIN_056905_WW` device. The expected entity IDs are not guaranteed if Home Assistant already has entity-registry collisions or retained old discovery entries. The implementation should keep the local fork easy to maintain while reusing the validated RAC mapper behavior already proven for this unit.

## Current Evidence

The RAC validation branch already routes `WIN_056905_WW` through the RAC mapper and handles the AC's `0xa7` TLV notifications. Local captures show these V1 source TLVs:

- `0x1fd`: room/current temperature, decoded as `raw / 2` C.
- `0x2b3`: estimated power, decoded with the existing RAC formula `Math.max(5, raw - 60)` W.
- `0x332`: outdoor-side air temperature, decoded through `racAirTemp[255 - raw]` C.

The legacy WIN mapper can surface climate current temperature, but it does not expose the live diagnostic telemetry path that RAC already has. Older retained MQTT/HA entities prove some RAC diagnostics existed previously, but retained unavailable entities are not the complete capability inventory and should not define V1 scope.

## Non-Goals

V1 does not expose every observed or retained diagnostic. These stay out of scope:

- Error code `0x221`
- Nominal capacity `0x32e`
- EEV opening `0x330`
- ODU HEX / coil temperature `0x32c`
- Compressor-ish values `0x22a` and `0x32f`
- Unknown changing TLVs such as `0x228`, `0x229`, `0x232`, `0x233`, `0x32b`, `0x355`, and `0x356`
- kWh energy integration, energy-dashboard support, calibration controls, or derived "compressor running" helpers
- HA template sensor changes
- Live Home Assistant, KITT, Daisy, MQTT, SSH, or service changes during spec/plan/code review

## Architecture

Use a thin fork-only mapper layered over RAC.

Add a local fork-owned device class, tentatively `cloud/devices/HAL_LW1022FVSM.ts`, that subclasses the RAC mapper. Register it from `cloud/ha_bridge.ts` for the installed AC's model route:

```ts
WIN_056905_WW: HAL_LW1022FVSM
```

The mapper must keep the original metadata model ID unchanged as `WIN_056905_WW`; existing RAC WIN-family behavior keys off that metadata. The fork-only class should be a small overlay, not a copied RAC implementation.

This route is model-ID based because `ha_bridge.ts` currently dispatches ThinQ2 devices by `meta.modelId`. V1 intentionally relies on Hal's household invariant: this fork/home will only have one `WIN_056905_WW`, the installed LW1022FVSM. No device-id allow-list or multi-`WIN_056905_WW` fallback is required for V1.

Because RAC currently builds much of its discovery config in one method, the implementation may need small upstream-friendly extension points in `RAC_056905_WW.ts`. Acceptable generic hooks include:

- A way for subclasses to suppress or filter RAC's generic optional sensors before field registration, including both diagnostic sensors and RAC's existing `energy_current` power sensor.
- A way for subclasses to add extra MQTT components before `setConfig(config)` and `publishKnownState()`.
- A way for one TLV to publish to multiple HA properties without overwriting `TLVDevice.fields_by_id`.

The last point is required for room temperature: TLV `0x1fd` must continue updating `climate.current_temperature` and also update the standalone room temperature sensor.

Filtering must happen before `addField()` registration, or it must remove both the discovery component and the corresponding `fields_by_id` entry. Removing only `config.components[...]` after RAC registers a field is not enough.

Do not add a second `0x1fd` field unless `TLVDevice` supports fanout or arrays for `fields_by_id`. Overwriting `fields_by_id[0x1fd]` is a bug.

For this fork mapper, RAC's generic `energy_current` and `oduairtemp` components are replaced by `estimated_power` and `outside_temperature`. The fork mapper must not publish both `$deviceid-energy_current` and `$deviceid-estimated_power`, and must not publish both `$deviceid-oduairtemp` and `$deviceid-outside_temperature`.

For the fork mapper, the only additional sensor components beyond retained climate/control behavior are `room_temperature`, `estimated_power`, and `outside_temperature`. Suppress all RAC optional telemetry/diagnostic sensor components for this model, including `error`, `capacity`, `eev`, `pipeintemp`, `pipeouttemp`, `oduhextemp`, `oduairtemp`, `energy_current`, `autodry`, `autodryremain`, and filter time/date sensors, unless a later spec explicitly whitelists one.

V1 must publish exactly the configured no-dash state topics: `$this/room_temperature`, `$this/estimated_power`, and `$this/outside_temperature`. Current `TLVDevice.addField()` property names can produce trailing-dash topics when `name: ''` is used; the implementation must avoid `room_temperature-`, `estimated_power-`, and `outside_temperature-` by using a small generic property/topic override or explicit callback fanout.

Do not solve this by copying `initMakeSetConfig()` into the fork file. If the only apparent implementation path is a large method copy, stop and revise the plan before coding.

## MQTT Sensor Requirements

All three V1 sensors are normal first-class sensors, not diagnostics. They must omit `entity_category: diagnostic` so they are convenient for dashboards, history, helpers, and automations.

### Room Temperature

Source TLV: `0x1fd`

Decode: `raw / 2`

MQTT discovery component:

- Component key: `room_temperature`
- `platform`: `sensor`
- Name: `Room temperature`
- Unique ID: `$deviceid-room_temperature`
- State topic: `$this/room_temperature`
- Device class: `temperature`
- `unit_of_measurement`: `°C`
- State class: `measurement`
- Suggested display precision: `1`

Behavior:

- Continue publishing the climate entity's `current_temperature`.
- Publish the same decoded value to `room_temperature`.
- Publish decoded Celsius values from rethink and let Home Assistant handle display conversion for Fahrenheit installations.

### Estimated Power

Source TLV: `0x2b3`

Decode: `Math.max(5, raw - 60)`

MQTT discovery component:

- Component key: `estimated_power`
- `platform`: `sensor`
- Name: `Estimated power`
- Unique ID: `$deviceid-estimated_power`
- State topic: `$this/estimated_power`
- Device class: `power`
- `unit_of_measurement`: `W`
- State class: `measurement`
- Suggested display precision: `0`

Behavior:

- Treat this as estimated instantaneous watts, not a revenue-grade measurement.
- Do not claim kWh or energy-dashboard compatibility in V1.
- Preserve the existing lower clamp to `5 W` for low/raw idle values.

### Outside Temperature

Source TLV: `0x332`

Decode: `racAirTemp[255 - raw]`

MQTT discovery component:

- Component key: `outside_temperature`
- `platform`: `sensor`
- Name: `Outside temperature`
- Unique ID: `$deviceid-outside_temperature`
- State topic: `$this/outside_temperature`
- Device class: `temperature`
- `unit_of_measurement`: `°C`
- State class: `measurement`
- Suggested display precision: `1`

Behavior:

- This is the AC's outdoor-side air reading, not an official weather station reading.
- Expose it as a normal sensor because Hal may use it in dashboards and automations.
- If `0x332` is absent from initial values, do not invent the sensor.

## Discovery And Availability

Use rethink's existing MQTT discovery model and device availability:

- Device-scoped components under the existing LG AC device.
- Existing availability model: `availability: [{ topic: "$this/availability" }, { topic: "$rethink/availability" }]` with `availability_mode: "all"`.
- No `expire_after` in V1.
- Retain existing climate behavior and controls.

The V1 sensors should be registered only when their source TLVs are known for the device during config construction. Use presence checks such as `raw_clip_state[id] != null`, not truthiness checks, so present low/raw zero values still register and publish correctly. The implementation may use the already captured LW1022FVSM initial values fixture to make this deterministic in tests.

## Retained Discovery Cleanup

V1 code must not publish out-of-scope components. However, omitting an old component from new discovery is not the same as cleaning a retained HA/MQTT discovery entry.

Any cleanup of old retained entities such as `energy_current`, `oduairtemp`, `oduhextemp`, `capacity`, `eev`, or `error` is a separate deployment operation. It requires explicit user approval and should use Home Assistant MQTT device discovery's supported component-removal update, followed by the final retained device config with the component omitted. Do not publish an empty payload to the whole device discovery topic unless intentionally removing the whole device. This spec does not authorize live broker or HA cleanup.

## Fork And GitHub Release Workflow

This work is intended for Hal's fork release, not as the next upstream PR against `anszom/rethink`.

Remote preflight from this checkout shows:

- `fork` is `https://github.com/gonkey42/rethink.git`.
- `origin` is `https://github.com/anszom/rethink` with push disabled.
- Hal refreshed the fork, and a read-only remote check confirmed `fork/master` matches `origin/master` at the time this spec was written.
- `fork/codex/lw1022fvsm-rac-live-validated` exists and is the known-good RAC validation branch.
- No `hal/release-lw1022fvsm` branch was visible in `fork` during the latest preflight.

Do not redo the GitHub fork. Instead, create or update the release branch deliberately before implementation. These are future implementation-phase Git operations; spec review approval alone does not authorize fetches, branch creation, pushes, or other ref writes.

1. Fetch the current upstream and fork refs.
2. Verify `fork/master` still matches the intended upstream base.
3. Decide the release base from current upstream plus the known-good RAC validation work.
4. Create `hal/release-lw1022fvsm` in Hal's fork if it is absent.
5. If `hal/release-lw1022fvsm` already exists, update it only by fast-forward or reviewed PR/merge after the verification gate.
6. Stop for explicit approval before any non-fast-forward update, rebase, reset, or force-push of the release branch.
7. Create the telemetry feature branch from the release branch.

Implementation should happen on a feature branch from the refreshed fork release base, for example:

- Base inputs: current upstream `master` plus `codex/lw1022fvsm-rac-live-validated`
- Feature branch: `hal/lw1022fvsm-v1-telemetry`
- Release branch target in the fork: `hal/release-lw1022fvsm`

If `hal/release-lw1022fvsm` does not exist yet, create it from the refreshed release base before opening the feature PR. The branch names can change, but the roles should not:

- Feature branch: short-lived work for this telemetry change.
- Release branch: Hal's deployed household branch.
- Upstream/master: periodically synced source, not the deployment authority for this AC.

When implementation is complete and verified, push the feature branch to the `fork` remote and open a draft PR in Hal's fork targeting the release branch. The PR description should include:

- Scope: Hal's installed LW1022FVSM only.
- New sensors and source TLVs.
- Known limitations of estimated power and outside temperature.
- Test/build commands run.
- Confirmation that no live HA/KITT/Daisy/MQTT/SSH/service changes were made by the PR work.

Do not push to upstream `origin` for V1. If a small generic hook is clearly upstreamable, it can be split into a later upstream PR after the local release path is stable.

## Merge And Release Gate

Before merging the fork PR into the release branch:

- Working tree is clean except for intentional committed changes.
- `git diff --check` passes.
- Targeted telemetry tests pass.
- Existing RAC/WIN regression tests pass.
- `npm test` passes, or any unrelated failure is documented.
- `npm run build` passes.
- The final diff is reviewed for accidental broad RAC rewrites.
- The PR contains no live deployment steps, SSH/service/MQTT/HA changes, secrets, or host-specific operational edits.

After merge, deployment is a separate step and must be explicitly approved. The spec does not authorize touching KITT, HA, Daisy, MQTT, SSH, or services.

## Upstream Sync Strategy

The fork does not automatically absorb upstream changes. Keep the release branch current by periodically fetching upstream, creating a sync branch from `hal/release-lw1022fvsm`, merging or rebasing that sync branch onto current `origin/master` as appropriate, rerunning the same local verification gate, and merging the sync branch back through a reviewed PR. Do not rebase or force-push the published release branch.

This design minimizes fork tax by keeping Hal-specific behavior in one mapper file plus a small bridge route. Conflicts may still occur in `ha_bridge.ts`, `RAC_056905_WW.ts`, or `tlv_device.ts` if generic hooks are needed, but the spec intentionally avoids a large private RAC copy.

## Test Requirements

Add tests before or with implementation. At minimum:

- Bridge routing: `WIN_056905_WW` maps to the fork-only LW1022FVSM mapper.
- `0xa7` TLV frame parsing still works.
- `0x1fd` updates both `climate.current_temperature` and `room_temperature`.
- `0x2b3` publishes `estimated_power` using `Math.max(5, raw - 60)`.
- `0x332` publishes `outside_temperature` using `racAirTemp[255 - raw]`.
- The three MQTT discovery components are normal sensors with no diagnostic entity category.
- Discovery assertions cover exact `platform`, `unique_id`, `state_topic`, and `unit_of_measurement` values.
- No V1 state publishes use trailing-dash topics such as `room_temperature-`, `estimated_power-`, or `outside_temperature-`.
- `energy_current` and `oduairtemp` are not published alongside their V1 replacements.
- Retained/out-of-scope diagnostics are not resurrected by accident in the fork-only mapper, and denied component keys are absent from MQTT discovery.
- Initial `publishKnownState()` and later notifications both update `climate.current_temperature` and `room_temperature`.
- Presence checks handle `0x2b3 = 0`, `0x2b3 < 60`, `0x2b3 > 60`, and absent `0x2b3` correctly.
- Presence checks handle absent `0x332` correctly.
- Existing RAC regression tests still pass.

Test fixtures should use the known LW1022FVSM captures where possible, including at least one sample with `0x2b3` and one with `0x332`.

## Open Decisions

None for V1 scope. The chosen V1 scope is:

- Installed LW1022FVSM only.
- Standalone room temperature sensor.
- Standalone estimated power sensor.
- Standalone outside temperature sensor.
- GitHub fork PR/release workflow included.
- No implementation plan until this spec is reviewed and explicitly approved.
