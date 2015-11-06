<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright (c) 2015, Joyent, Inc.
-->

# sdcadm Changelog

## 1.8.1

- TOOLS-1264/TOOLS-563: Moved sdcadm subcommands to their own files and added
  `sdcadm experimental update` and `scdadm experimental avail` which can handle
  individual updates (and availability) of vm, cn and net agents.
- TOOLS-1252: `sdcadm avail sdcadm` and `sdcadm avail` will now include
  `sdcadm` available images without adding `sdcadm` to SAPI services.
  (This may be modified in the future).

## 1.8.0

- TOOLS-1251: `sdcadm self-update` no longer updates to latest sdcadm available
  image and requires either a given image UUID or `--latest` option to be
  provided.

## 1.7.5

- TOOLS-1246: sdcadm commands would break due to bad sshpk 1.5.0 release

## 1.7.4

- TOOLS-1225 Drop confusing `-x,--exclude SERVERS` options on `sdcadm
  experimental update-agents ...` and `sdcadm platform assign ...`.  Also a
  number of robustness improvements to `sdcadm experimental update-agents`.

## 1.7.3

- TOOLS-1167/TOOLS-1166: sdcadm ex update-agents now updates node.config
  in all CNs, has limited concurrency and agentsshar file download and
  execution are now two separated steps
- TOOLS-1236: 'sdcadm avail' doesn't need to print out channel info
- TOOLS-1234: 'sdcadm post-setup underlay-nics -h' for help doesn't work
- TOOLS-1031: 'sdcadm post-setup underlay-nics' verifies that CNs have the
  configured fabric underlay network tag assigned to any actual nic before
  trying to add them an otherwise useless underlay nic.

## 1.7.2

- Implemented changes from https://github.com/joyent/rfd/tree/master/rfd/0009:
  Replaced `sdcadm experimental fabrics` + `sdcadm experimental portolan` with
  `sdcadm post-setup fabrics`. Dropped support for `--coal` option and added
  documentation about how to setup fabrics in CoaL to SDC's developers guide
  (https://github.com/joyent/sdc/blob/master/docs/developer-guide/coal-post-setup-fabrics.md).
- Get `sdcadm experimental default-fabric` out of experimental, i.e. now is
  `sdcadm default-fabric`.

## 1.7.1

- Deprecated 'latest' symlink for platforms
- Added `sdcadm platform set-default PLATFORM` subcommand
- Include default platform column in `sdcadm platform list`
- Added `sdcadm platform assign --latest`

## 1.7.0

- TOOLS-754: http_proxy support. If your SDC is firewalled of, but you
  have an HTTP proxy that can be used to given `sdcadm` (and IMGAPI)
  external access, then sdcadm can work with that.

        sapiadm update $(sdc-sapi /applications?name=sdc | json -H 0.uuid) \
            metadata.http_proxy=http://my-proxy.example.com:8080

  Then after a minute or two (to allow config-agents to update configurations
  appropriately) you should be able to 'sdcadm up ...' et al via
  that proxy.

  A side-effect of this change is that programmatic usage of "lib/sdcadm.js"
  must explicitly finialize the `SdcAdm` instance:

        var SdcAdm = require('./lib/sdcadm');
        var adm = new SdcAdm({...});
        // ...
        adm.fini();

## 1.6.1

- `sdcadm experimental udpate-agents` now runs its own Ur Queue, instead of
  passing a script to each CN using sdc-oneachnode. Command options have been
  modified accordingly.

## 1.6.0

- Changed the behaviour of `sdcadm update --all --force-rabbitmq` and
  `sdcadm update --all --force-data-path` to allow updating of rabbitmq
  and portolan (currently the sole "data path" service) along with the
  usual `--all` services.
- Allows `sdcadm avail` to show available updates for portolan and rabbitmq.
- Added `sdcadm platform avail`

## 1.5.8

- Added `--force-data-path` option for portolan upgrade

## 1.5.7

- Added `sdcadm avail(able)`.
- Added `sdcadm channel get`
- Added `-x|--exclude` option to `sdcadm update` and `sdcadm avail`.
- Added `-k|--keep-latest` option to `sdcadm platform remove`

## 1.5.6

- Add support for installing custom TLS certificates for sdc-docker with
  `sdcadm experimental install-docker-cert`
- `sdcadm experimental update-docker` now ensures that the zone has
  a delegate dataset

## 1.5.5

- Support full HA for `sdcadm update mahi`.
- TOOLS-913, TOOLS-910, TOOLS-684 A number of fixes to properly support pulling
  and updating from channels other than the default.

## 1.5.4

- Add `sdcadm experimental default-fabric <UUID>` for adding a default fabric
for a user

## 1.5.3

- `sdcadm experimental fabrics` now requires the `sdc_nat_pool` property in
its config for configuring the fabric NAT network pool.

## 1.5.2

- Added `--force` and `--yes` option to `sdcadm experimental update-agents`.
- Added ability to continue from a previously failed run to
`post-setup ha-manatee`.

## 1.5.1

- Added `sdcadm channel` to retrieve available update channels and
set/unset `updates_channel` into SAPI.

## 1.5.0

- Added `sdcadm experimental fabric` to initialize the SDC fabrics
sub-system.

## 1.4.5
- Added `sdcadm platform`. Moved `sdcadm experimental assign-platform` and
`sdcadm experimental install-platform` under `sdcadm platform` command as
`assign` and `install`. Also added `list`, `usage` and `remove` subcommands.

## 1.4.4

- Modified `sdcadm post-setup zookeeper` to use binder images instead of
zookeeper images.
- Added `sdcadm rollback`

## 1.4.3

- Added DNS to docker and portolan instances.
- Stop lying regarding image used for ha-manatee.
- Added `--just-download` option to `sdcadm experimental update-gz-tools`
and `sdcadm experimental update-agents`.

## 1.4.2

- Added `sdcadm experimental portolan` to add/update the portolan service.
- Everything `sdcadm experimental` added to `sdcadm history`.

## 1.4.1

- Added `sdcadm create <service> --server=<UUID> [--image=<UUID>]`.
- Moved `sdcadm experimental add-2nd-manatee` to `sdcadm post-setup ha-manatee`
and include creation of 3rd manatee instance as part of it.

## 1.4.0
- Add `sdcadm post-setup zookeeper` to create the zookeeper service and add a
cluster of zookeeper instances.
- Added `sdcadm update zookeeper`.
- Added a warning for users when an image download fails due to the lack of
external nic for IMGAPI
- Save `self-update` changes into history.
- Save history into SAPI when available.

## 1.3.9

- Add `sdcadm experimental update-docker` to add/update the docker service &&
  docker0 instance.
- Added post-setup commands, `cloudapi`, `common-external-nics`

## 1.3.8

- Add `sdcadm experimental install-platform` and `sdcadm expertimental assign-platform`

## 1.3.7

- Add `sdcadm check-health` as an eventual replacement for `sdc-healthcheck`.

## 1.3.6

- Add `sdcadm experimental add-new-agent-svcs`.
- Support full HA for `sdcadm update moray`.

## 1.3.5

- Add `sdcadm update mahi` with support for creating a delegate dataset
- Add `sdcadm update binder`
- Add `sdcadm experimental update-gz-tools` to be able to update global zone
  tools
- Add `sdcadm update manatee` both, for HA setups and single dev VM.
- Add `sdcadm experimental add-2nd-manatee --server=<UUID>` to create the
second manatee VM for HA.

## 1.3.4

- Add `sdcadm experimental update-agents` to be able to update agents

## 1.3.3

- Add --all flag for updating all available services at once.
- Add `sdcadm update sapi`, limited to a single instance on the headnode.
- Add `sdcadm update moray`, limited to a single instance on the headnode.
- Add `sdcadm update ufds`, limited to a single instance on the headnode.

## 1.3.2

- Add `sdcadm update --force-same-image ...` to be able to for an
  update/reprovision of an instance using the same image. Usually that
  would be a no-op.

- `sdcadm update` can now update imgapi, limited to a single imgapi
  instance on the headnode.

- Add `sdcadm experimental update-other` temporary grabbag of SDC update
  steps.

## 1.3.1

- Add `sdcadm experimental dc-maint` for starting and stopping DC maintenance
  mode (i.e. putting cloudapi in readonly mode).

## 1.3.0

- Add --force-rabbitmq flag and prevent updating of RabbitMQ if flag not used.

## 1.2.5

- TOOLS-582 correct bug in self-update that would break when multiple build
  branches were available.

- TOOLS-581 a self-update that finds no updates should not create a
  /var/sdcadm/self-updates dir

## 1.2.4

- Add 'sdcadm check-config'.

- Add 'sdcadm experimental ...'  where experimental commands will hang
  until fully integrated into the planned upgrade process.

## 1.2.3

- Save old user-script to 'sdcadm update' work dir for possible rollback.


## 1.2.2

- `config.vmMinPlatform` guard for minimum platform supported for core
  VM updates.
- `sdcadm svcs` lists one service per row, JSON is mostly from SAPI's
  ListServices.
- `sdcadm insts -I` to group by (service, image) unique pairs


## 1.2.1

- 'sdcadm update' will correctly do nothing (saying "Up-to-date") if the given
  services are already at the latest candidate image. It also now properly
  excludes images published earlier than the currently used image as update
  candidates.
- 'sdcadm update <svc>@<version>' and other calling forms

## 1.2.0

- Change shar self-installer input envvar from SDCADM_LOGDIR to SDCADM_WRKDIR.
- 'sdcadm update -I ...'

## 1.1.0

- First stab at `sdcadm update SERVICE`. Currently limited to most of the stateless
  services (e.g. vmapi, cnapi) with just a single instance, and only on the headnode.

## 1.0.4

- TOOLS-437: `sdcadm instances`, `sdcadm services`.

## 1.0.3

- TOOLS-436: `sdcadm self-update`

## 1.0.0

First version.
