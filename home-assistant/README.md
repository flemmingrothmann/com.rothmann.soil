# Home Assistant

Home Assistant runs as a Docker container on `hubert` and uses host networking for local discovery.

## Start

```sh
docker compose up -d
```

Open `http://192.168.100.66:8123` to finish the initial setup.

## Matter

Matter over Wi-Fi uses a separate Matter Server container on `hubert`. See
[`../matter-server/README.md`](../matter-server/README.md) for deployment, pairing,
backup and the future Thread plan using the currently disconnected Sonoff Dongle-E.

## Zigbee

The Sonoff Dongle-P must be owned exclusively by Zigbee2MQTT, not Home Assistant/ZHA. Use its stable path in the Zigbee2MQTT configuration:

```text
/dev/serial/by-id/usb-ITead_Sonoff_Zigbee_3.0_USB_Dongle_Plus_c24fa5037f15f01189c8e374b887153e-if00-port0
```

## Watering Packages

Home Assistant loads `packages/` through `homeassistant.packages`. Each watering
circuit has one package with its helpers and one label-driven blueprint instance.
Use a shared device label to define irrigation membership; an HA area remains
physical placement only.

## Christmas Lights

See [`../docs/christmas-lights.md`](../docs/christmas-lights.md) for label membership,
manual override, time/lux rules, tests and personal holidays from Google Calendar.
The HA sidebar dashboard **Julelys** contains the master and manual controls.
