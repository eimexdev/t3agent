# Checkpoint browser voice recordings locally

The web client records in the browser's best supported compressed format and periodically checkpoints encoded chunks plus waveform peaks to IndexedDB. This allows cross-thread and background recording, keeps unsent audio local, and recovers usable interrupted drafts after refreshes, crashes, permission loss, or device failure; T3 Agent does not transcode recordings in the browser.
