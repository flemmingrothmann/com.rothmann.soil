# Zigbee2MQTT

Zigbee2MQTT exclusively owns the Sonoff Dongle-P. Do not configure ZHA or any other Zigbee service to use it.

## Services

- Zigbee2MQTT frontend: `http://192.168.100.66:8080`
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

`external_converters/arteco-zs-304z-battery.mjs` extends the official ZS-304Z definition with the standard Zigbee `batteryPercentageRemaining` attribute. Z2M exposes it as `battery` in percent (`200` becomes `100 %`) instead of relying on the coarse Tuya `battery_state` value.

## Outstanding Sensor Work

- When the unpaired China Zigbee soil sensor is added, inspect its model, fingerprint and battery clusters. Add a model-specific external converter only if it exposes a reliable raw battery attribute, following the ZS-304Z approach.
- Third Reality `3RSM0147Z` uses Zigbee2MQTT's built-in support. Verify its battery entity after pairing before adding any custom converter.
