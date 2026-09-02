# edid/

`cable82-640x480-audio.bin` is a 256-byte EDID: a 640x480 4:3 screen that accepts stereo PCM audio over HDMI.

It exists because cheap HDMI-to-RF modulators and HDMI-to-composite converters send no EDID at all.
Without one the Pi guesses a widescreen mode and refuses to send HDMI audio.
Hand it to the kernel and both problems go away (the full recipe is step 4 of [Running it on a real CRT](../README.md#running-it-on-a-real-crt-raspberry-pi) in the main README):

```
sudo mkdir -p /lib/firmware/edid
sudo cp edid/cable82-640x480-audio.bin /lib/firmware/edid/cable82.bin
# then append to /boot/firmware/cmdline.txt:
#   video=HDMI-A-1:640x480@60D vc4.force_hotplug=1 drm.edid_firmware=HDMI-A-1:edid/cable82.bin
```

`make-edid.py` regenerates it from scratch (Python 3, no dependencies).
`edid-decode --check edid/cable82-640x480-audio.bin` reports conformity PASS.
