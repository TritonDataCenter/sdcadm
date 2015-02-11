<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright (c) 2015, Joyent, Inc.
-->

# sdcadm Changelog

## 1.5.0
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
