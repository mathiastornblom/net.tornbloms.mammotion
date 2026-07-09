## Aliyun / MQTT Notes
- Auth endpoint: `https://api.link.aliyun.com` (Chinese server — may need unblocking)
- MQTT broker: regional, obtained after auth
- Topic pattern: `/{productKey}/{deviceName}/user/...`
- Messages: Protobuf-encoded, same as pymammotion
- BLE service UUID: `0000ffff-0000-1000-8000-00805f9b34fb`
- BLE local name patterns: `Luba-*`, `Yuka-*`
