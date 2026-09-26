# Backups

An optional shortcut to the deployment's trusted **Admin → Backups** page. Creating this app does
not enable backups or grant administrator access. The admin page shows authoritative setup,
coverage, scheduling, history, archive verification, and isolated restore results.

This blueprint has no privileged bindings and stores no recovery keys or backup data. Keep all
backup actions in the trusted admin page. The deployment operator configures storage and the public
recovery key; retain its matching private key in an offline recovery kit. Isolated restore staging
does not perform a production cutover.

Exporting this shortcut downloads setup instructions only. It does not export an archive or a key.
