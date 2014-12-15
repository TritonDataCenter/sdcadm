<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright (c) 2014, Joyent, Inc.
-->

# sdcadm

This repository is part of the Joyent SmartDataCenter project (SDC).  For
contribution guidelines, issues, and general documentation, visit the main
[SDC](http://github.com/joyent/sdc) project page.

`sdcadm` is a tool that lives in the SmartDataCenter headnode GZ for
handling SDC upgrades, listing of services and instances, health checks, and
other SDC setup duties.

Please see docs/index.md for more details.

--

# sdcadm self-update

It's always recommendable to run `sdcadm self-update` before to perform any
sdcadm upgrade operation, specially because there could be critical bugfixes
published since the last time sdcadm itself was updated.

You can get the exact version of sdcadm running into your SDC setup using:

        sdcadm --version

The output of this command will include both, the semver version, and the usual
image version, referencing git branch, date and git SHA. For example:

        [root@headnode (coal) ~]# sdcadm --version
        sdcadm 1.3.9 (master-20141114T063621Z-g995ee7e)

--

# SDC post-setup with sdcadm

The default setup of a SmartDataCenter is somewhat minimal. There are several
post-setup steps required in order to get it configured for practical usage.

## Add external nics to imgapi and adminui

These are required in order to be able to access remote update sources, and in
order to be able to access AdminUI using a browser:

    sdcadm post-setup common-external-nics

Please, note that this command didn't wait for "add nics" jobs to be completed,
so it might require you give it some extra time after the command exits until
these jobs really finish.

## Create CloudAPI VM

If non-administrator access to the SDC setup is planned, the CloudAPI zone must
be created:

    sdcadm post-setup cloudapi

## Add Zookeeper service cluster and switch SDC services to use it

By default, a SDC setup runs with a single zookeeper instance running into the
`binder` instance. This is not the recommended setup for a production
environment; instead, it's recommended to create a *"cluster"* of 3 or 5
zookeeper instances, and reconfigure the services using zookeeper to use it.

In case this is a setup already being used by non-administrator users, it's a
good idea to put the DC in maintenance `sdcadm experimental dc-maint --start`.

    sdcadm post-setup zookeeper \
        --servers=`CN1_UUID` \
        --servers=`CN2_UUID`

This command will create 3 zookeeper instances, the first of them into the
Headnode, then another one into the CN identified by CN1\_UUID and the last
one into CN2\_UUID.

If you need to create a cluster of 5 instances, you just need to pass couple
more CN UUIDs to this command.

Once the zookeeper instances have been configured and all of them have joined
the *"cluster"*, manatee and moray will be reconfigured to begin using this
setup instead of the zookeeper service running into the `binder` instance.

If you put the DC into maintenance, remember to recover it from such state
by using `sdcadm experimental dc-maint --stop`, unless you want to proceed
with ha-manatee too

## Create the required manatee instances for HA

When you have one manatee initially, you're in ONE\_NODE\_WRITE\_MODE
which is a special mode that exists just for bootstrapping. To go
from this mode to a HA setup you'll need at least one more manatee.
Switching modes however is not quite as simple as just provisioning a
second one. It involves the following steps:

- create a second manatee instance for you (with manatee-sitter disabled)
- disable the ONE\_NODE\_WRITE\_MODE on the first instance
- reboot the first manatee into multi-node mode
- re-enable the sitter and reboot the second instance
- wait for manatee to return that it's synchronized

After we've gone through this, it'll create a 3rd manatee instance on the
second server you specified to complete manatee ha setup.

Aside all these details, all you need to run is:

        sdcadm post-setup ha-manatee \
        --servers=`CN1_UUID` \
        --servers=`CN2_UUID`

It's always a good idea to run `sdcadm check-health` and `sdc-healthcheck`
once this command has been completed, in order to review that everything
reconnected to manatee/moray successfully.

## Create the desired number of moray instances for HA

Finally, it's desirable to have more than the default single moray instance
for HA. Creation of additional moray instances didn't require any special
command, just the standard `sdcadm create` used to create any additional
instance of any service (see docs/index.md for the details).

The recommended setup would include two additional moray instances created
into the same CNs we added the manatees on the previous step:

    sdcadm create moray --server=CN1_UUID
    sdcadm create moray --server=CN2_UUID

And that's it. With this, we should have a setup with multiple zookeeper,
manatee and moray instances, ready to operate with HA. As an additional step,
if you plan to give access to non-administrator customers to your SDC setup,
i.e., if you've installed CloudAPI, it would be handy to also have several
mahi instances for HA. You can create them, and in general, any additional
instance for services "HA Ready", using the same procedure than for moray:

    sdcadm create mahi --server=CN1_UUID
    sdcadm create mahi --server=CN2_UUID

--

# Manage SDC upgrades with sdcadm

The following is a detailed list of the required steps in order to verify that
a given SDC setup can be updated using `sdcadm` and, if possible, how to
proceed.

## Verify that we can perform the updates using sdcadm

Any SDC setup must fulfil some requirements in order to be "updateable" using
`sdcadm`: the VMs for the different SDC services must be past the **minimal
versions** detailed at `etc/defaults.json` under `svcMinImages`. Additionally,
each one of these images imposes a constraint over the minimal platform version
required for the images to work.

The easier way to check if we're past these requirements is to invoke `sdcadm`.
In the case that `sdcadm` finds any issue with any of the services VMs, it will
not reach that point and will notify you about the problem. Otherwise, you'll
continue onto the next step.

The detailed list of commands to run in order to verify that we can proceed
with the upgrade is:

      sdcadm update --all --just-images
      sdcadm update manatee --just-images
      sdcadm update zookeeper --just-images

Of course, this assumes that you already setup a zookeeper cluster using
`sdcadm post-setup`, if that's not the case you can just skip that step.

## Download everything before running the upgrades

It's a good idea to pre-download all the bits required for an upgrade before
actually going through it. That's the reason we've run the previous
`sdcadm update` command with the `--just-images` option.

Right now, it's not possible to pre-download some images for other SDC
components, like agents or gz-tools, using `sdcadm`. Anyway, it's possible to
download them using `updates-imgadm` as follows:

      updates-imgadm get-file <IMG_UUID>

Either way, the `sdcadm experimental` subcommands we're gonna mention below
should be able to download and install the required images, or to proceed
with the path given to an image file as documented into `docs/index.md`.

You can download and *"install"* the OS platform for later assignation to
the CNs you want to upgrade by running:

      sdcadm experimental install-platform --latest

This will only download and make the platform available for later usage, but
will not assign it to any server.

## Proceeding with the upgrade

### Verify the DC is healthy

In the future, you should only run `sdcadm check-health` in order to know if
all the services on a given SDC setup are healthy. Until that happens, it's
also recommended to run `sdc-healthcheck` to check if anything is out of
order.

The logical first step if something is not working properly would be to fix
such issue before proceeding with the upgrade, unless you know the upgrade
itself contains the fix for such problem.

### Put the DC in maintenance

    sdcadm experimental dc-maint --start

### Backup PostgreSQL

    MANATEE0_UUID=$(vmadm lookup -1 alias=~manatee)
    zfs snapshot zones/$MANATEE0_UUID/data/manatee@backup
    zfs send zones/$MANATEE0_UUID/data/manatee@backup >./manatee-backup.zfs
    zfs destroy zones/$MANATEE0_UUID/data/manatee@backup

### Upgrade Global Zone Tools

    sdcadm experimental update-gz-tools --latest

### Upgrade other SDC minor pieces, if required

    sdcadm experimental update-other

### Upgrade agents

    sdcadm experimental update-agents --latest

### Upgrade all the non-HA services

    sdcadm update --all

### HA

At this point, you should be able to either update the HA pieces of SDC or, in
case you haven't gone through HA setup yet, proceed with such process taking
advantage of the DC maintenance period.

Of course, you can also complete the HA setup whenever you need to. Let's
assume that you already went through the process described to complete the
post-setup installation of SDC HA pieces, and we're going to just update an
existing HA setup. On such case, you just need to run:

    sdcadm update zookeeper

Then, run `sdc-healthcheck` to make sure everything is properly reconnected
to moray. Once zookeeper VMs have been updated, the next step is to update
manatee by running:

    sdcadm update manatee

and, again, some `sdcadm check-health`/`sdc-healthcheck` would be highly
recommended.

#### Non-HA setup

In case you don't wanna run manatee HA, you can still update your manatee VM
by running exactly the aforementioned command:

    sdcadm update manatee

and things should happen exactly the same way than for HA-manatee.

### Assign platform and reboot accordingly

Note that you only need to go through this step if you plan to upgrade the OS
platform during the upgrade.

You can assign the downloaded platform image to one or more servers using:

      sdcadm experimental assign-platform PLATFORM SERVER_UUID
      sdcadm experimental assign-platform PLATFORM --all

where `PLATFORM` is the platform name. If you need to update more than one
server, but don't want to update all of them, you'll need to run

      sdcadm experimental assign-platform PLATFORM SERVER_UUID

as many times as servers you need to update.

Once you're done with this procedure, it's the moment to reboot the servers
with an updated platform assignment.

In case you need to reboot the HeadNode:

      shutdown -y -i6 -g0

And, in order to reboot other CNs:

      sdc-cnapi /servers/$CN_UUID/reboot -X POST

### Take the DC out of maintenance

    sdcadm experimental dc-maint --stop

And that's it, with this final step, the DC should be full operational again.
It's a good idea to run the health check commands before stopping the
maintenance window, just in case.

Finally, if you have some Amon alarms raised during the upgrade period, this is
a good moment to clear them all.
