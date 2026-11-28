# Integration summary

The supplied `worker.js` is a full replacement for the processor source that was provided earlier. It imports `./ai-subtitle`, starts AI subtitle generation from `rawPath` before the conversion/copy branch, and awaits the AI result before SRT-to-VTT conversion and R2 subtitle upload.

`server.js` is not included or changed. Keep your existing server entrypoint, `.env`, queue data, and all existing credentials/configuration.

Check the actual project uses this processor file as `worker.js` (or the module imported by your server) before replacing it.
