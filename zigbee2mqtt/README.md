# Zigbee2MQTT

Zigbee2MQTT exclusively owns the Sonoff Dongle-P. Do not configure ZHA or any other Zigbee service to use it.

## Services

- Zigbee2MQTT frontend: `http://192.168.100.67:8080`
- MQTT broker: loopback-only on `127.0.0.1:1883`

Pairing is disabled by default. Enable it only for a controlled pairing session in the Zigbee2MQTT frontend.

## Home Assistant

Add the built-in MQTT integration in Home Assistant through `Settings -> Devices & services -> Add integration -> MQTT`.

- Broker: `127.0.0.1`
- Port: `1883`
- Username: `zigbee2mqtt`
- Password: read `mqtt_password` from `/opt/soil/zigbee2mqtt/data/secret.yaml` on `hubert`.

Zigbee2MQTT publishes Home Assistant MQTT discovery messages once this integration is connected.

## Coordinator

```text
/dev/serial/by-id/usb-ITead_Sonoff_Zigbee_3.0_USB_Dongle_Plus_c24fa5037f15f01189c8e374b887153e-if00-port0
```

The Dongle-P uses the `zstack` adapter. Its network key, PAN id and extended PAN id are generated once into persistent `data/configuration.yaml` on first start.

## Arteco ZS-304Z Battery

`external_converters/arteco-zs-304z-battery.mjs` extends the current built-in **ZS-300Z** definition for the exact `ZS-304Z` / `Arteco` fingerprint with standard Zigbee `batteryPercentageRemaining`. Z2M exposes it as `battery` in percent (`200` becomes `100 %`) instead of relying on coarse Tuya `battery_state`. Inherit the upstream definition: do not copy its calibration/illuminance datapoints into the extension.

## HOBEIAN ZG-303Z Battery

`external_converters/hobeian-zg-303z-battery.mjs` extends the built-in **CS-201Z** definition from `devices/hobeian` for the exact `ZG-303Z` / `HOBEIAN` fingerprint. This is not the TS0601 variant also sold as ZG-303Z. Sensor settings/datapoints remain unchanged; battery uses standard `genPowerCfg.batteryPercentageRemaining` reporting and reads (`200` = `100 %`) instead of the Tuya battery datapoint.

Converters are loaded from `/opt/soil/zigbee2mqtt/data/external_converters/` on `hubert`. Both use definition version `1.0.0`, so a previously configured sleepy sensor is eligible for the new battery setup when it next wakes. Loading a converter alone is not proof of physical reporting.

## IKEA LED Driver Switch Exposure

`external_converters/ikea-led-driver-switch.mjs` extends the current built-in IKEA TRADFRI 30 W LED driver definition for the exact `TRADFRI Driver 30W` / `IKEA of Sweden` fingerprint. It exposes on/off as a switch instead of a dimmable light because the LED strip's analog sensors need the driver output to remain powered. The change removes brightness control and replaces the Home Assistant `light.*` entity with a `switch.*` entity. Its `1.0.0` version marks the exposure behavior.

The converter regression checks use Z2M 2.14.3's actual dependencies. Copy `zigbee2mqtt/tests/` next to `external_converters/` under `/app/data/`, then run:

```sh
docker exec -w /app zigbee2mqtt node --test /app/data/tests/arteco-battery.test.mjs /app/data/tests/hobeian-battery.test.mjs /app/data/tests/ikea-led-driver-switch.test.mjs /app/data/tests/prepared-battery.test.mjs
```

## Outstanding Sensor Work

- The verified runtime is pinned to **2.14.3**. Before further upgrades, test both raw and prepared converter definitions against the candidate image without a radio/network. See the [HA/Z2M upgrade record](../docs/hubert-ha-z2m-upgrade-review.md).

- For additional soil sensor variants, inspect model, fingerprint and battery clusters before adding a model-specific battery extension.
- Third Reality `3RSM0147Z` uses Zigbee2MQTT's built-in support. Verify its battery entity after pairing before adding any custom converter.
