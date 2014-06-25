---
title: sdcadm (Administer a SDC standup)
markdown2extras: wiki-tables, code-friendly, cuddled-lists, link-patterns
markdown2linkpatternsfile: link-patterns.txt
apisections:
---

# sdcadm

TODO

For now see [the design doc](./design.html).


# Configuration

Configuration files and vars for `sdcadm` are described in this section.
The runtime `sdcadm` config is loaded as follows:

1. Load defaults from "/opt/smartdc/sdcadm/etc/defaults.json".
2. Load and merge in values from "/var/sdcadm/sdcadm.conf" (JSON format), if
   that exists.
3. Load some SDC config data via `bash /lib/sdc/config.sh -json`.

Config vars are as follows:

|| **var** || **description** ||
|| updatesServerUrl || Default: `https://updates.joyent.com`. The server from which update images/packages are retrieved. ||
|| vmMinPlatform || A minimum supported platform version on which `sdcadm` supports deploying/updating VM instances. Currently the minimum is a platform build including the OS-2275 fix. ||
|| serverUuid || Typically set (on node setup) to the server's UUID. This is used for identification in the user-agent string. ||
