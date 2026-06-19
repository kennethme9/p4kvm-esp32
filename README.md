# P4 KVM

This project uses an ESP32 P4 (Rev < 3) and a Toshiba TC358743 HDMI to CSI adapter as an Remote IP KVM

## WARNING

This is NOT production software! THis is a POC, use this at your own risk! There are many bugs, there is NOT security, none. There is no wifi in this firmware, there is only ethernet.

## Parts Needed

- Waveshare p4 module with rpi CSI interface + ethernet
- Toshiba TC358743 HDMI to CSI adapter -

## Building

Use esp-idf, 6.0.1, run menuconfig, idf.py build flash monitor. Open p4kvm.local in your browser.

## Troubleshooting

- try plugging in your target system before booting the p4 kvm
- try a different HDMI cable or USB cable
- look at the diagnsotics for the tc358743: SYS_STATUS, i.e. (TMDS=1 HDMI=1 SYNC=1 DDC5V=1), they should all be 1

## Video

Chip revisions on the ESP32 P4 are very critical, this project assumes you have a Rev 1.3 chip. Rev 3 chips will be able to use H264 encoding, hopefully.

**CSI path is fixed** to **RGB888** for now, other options don't work well with the jpeg encoder.

## Menuconfig (`P4KVM`)

- **`P4KVM_TC358743_RST_GPIO`**: reset line (active low); use `-1` if unwired (default GPIO 23).
- **`P4KVM_JPEG_QUALITY`**: 1-100. (This is also available through the UI)
- **Ethernet**: `P4KVM_ETH_ENABLE` and RMII/MDIO/PHY GPIO options when `SOC_EMAC_SUPPORTED` applies.
