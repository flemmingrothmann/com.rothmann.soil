Rothmann Soil Sensors brings soil moisture sensors from multiple brands into one consistent Homey experience.

## Why this project exists

Soil moisture sensors are oddly underserved in Homey.

Third Reality's sensor is one of the few solid options available out of the box, but it is not exactly bargain-bin territory. Tuya users are, in a slightly chaotic way, more fortunate: there are lots of very cheap sensors out there, and quite a few of them are actually usable.

The bigger issue, though, is not only device availability. It is usability.

What I really want is simple:

Use Homey's zone card `Any <alarm> on` to trigger a watering alert when the soil becomes too dry.

That should be easy. It is not.

## The problem

Two things get in the way:

1. Soil moisture sensors typically do not expose a dedicated "soil dry" alarm.
2. `Soil Dry` is not a standard Homey alarm capability, so zone cards do not work with it as a custom alarm.

The closest built-in candidate is `alarm_water`.

Yes, that technically means the opposite.
Yes, that is a bit silly.
Yes, I am using it anyway.

Why? Because for my setup it works.

If you have leak sensors in the same zones, this becomes a bad idea because your flows will mix "my basement is flooding" with "my tomato plant is feeling dramatic".

I do not have leak sensors yet, so for now `alarm_water` is doing perfectly respectable work as a dry-soil alarm wearing a fake moustache.

## The long game

I would prefer to do this properly.

I have therefore created a Homey feature request for better flow and zone support for custom alarm capabilities:

https://community.homey.app/t/feature-request-better-flow-and-zone-support-for-custom-alarm-capabilities/153765

If Homey adds proper support, the plan is straightforward:

1. Move away from `alarm_water`
2. Introduce a proper custom dry-soil alarm
3. Add migration where relevant
4. Push the work upstream where it makes sense

That includes official apps where possible. I like local hacks, but I like sustainable community improvements even more.

## Project direction

This project is about making soil moisture support useful today, not someday.

That means:

1. Writing my own drivers where needed
2. Adapting existing drivers when that is the pragmatic route
3. Improving alerting and flow usability
4. Keeping the door open for upstream contributions

The first supported device is the Third Reality Smart Soil Moisture Sensor.

Tuya support may also land here, unless it can live upstream in a better home.

## Tuya and `com.arteco`

`https://github.com/philipostli/com.arteco` is a great project and already implements the ZS-301Z Tuya soil sensor.

I have a few ZS-304Z devices, so I am building on Philip's work rather than pretending I invented agriculture.

If Philip is happy with it, Tuya-related work should ideally go there.

If not, it will live here in this project. No hard feelings, just more repositories with dirt in them.

The ZS-304Z work is currently in a pull request on Philip's repository.

## Open source attitude

This project is opinionated, but not territorial.

If Homey improves zone alarms, if Third Reality changes direction, if `com.arteco` accepts a PR, or if a better shared approach appears, I am very happy to collaborate and move things where they belong.

The goal is not to be clever in a corner.
The goal is to make soil sensors genuinely useful in Homey.

## Licensing and attribution

This repository currently includes some device-specific assets derived from `hwzolin/com.thirdreality.app`, which is licensed under `GPL-3.0`.

That currently applies to the copied Third Reality device assets used for the `soil_moisture_sensor` driver.

See `THIRD_PARTY_NOTICES.md` for the exact files and attribution.

In practice, that means that if this repository is distributed with those derived assets included, it should be treated accordingly from a GPL point of view.

If I later want a cleaner licensing path for broader distribution, the straightforward fix is to replace those borrowed assets with original ones.
