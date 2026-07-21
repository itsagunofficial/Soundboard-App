# Pulseboard

A responsive soundboard that can play locally or synchronize sound triggers across phones, tablets, and computers on the same local network.

## Run it

1. In VS Code, open the integrated terminal and run `npm start`.
2. Copy the address beside your active **Wi-Fi** adapter (for example, `http://192.168.0.184:3000`). Do not use a VPN, VirtualBox, or other virtual-adapter address.
3. Open that address on every device using the same Wi-Fi.

## Connect devices

1. On the controlling device, tap **Local sync off** and choose **Sender**.
2. Keep the generated room code and press **Connect**.
3. On each listening device, turn on Local sync, choose **Recipient**, enter that room code, and press **Connect**.
4. Press a sound on the Sender: every connected Recipient plays it.

Sounds still work locally with sync turned off. The sound effects are generated in the browser, so no audio files or downloads are required.

## Custom audio

There are no built-in sound effects. Recipients can add a **private sound** with a stock emoji or their own PNG/JPG/WebP/GIF icon. Its audio is saved only in that recipient's browser; the Sender receives only an icon-and-name trigger button. When the Sender presses it, that recipient plays its local audio.

The Sender can also optionally share audio with the whole room. Shared files are stored under the local `custom` folder, and when a Recipient adds one to their board it's saved permanently in that browser (not just for the current tab session).

Allowed audio formats: **MP3, WAV, OGG, M4A, AAC, FLAC, WebM, and MP4 audio**, up to 25 MB.

## Notes

- The server listens on `0.0.0.0`, making it reachable from other devices on your LAN.
- If a phone is stuck loading, use the Wi-Fi adapter address above—not `localhost` and not a virtual-adapter address. Confirm both devices are on the same Wi-Fi, turn off mobile data/VPN temporarily, and allow Node.js through the Windows **private-network** firewall prompt if Windows displays one.
- Requires Node.js 18 or later.