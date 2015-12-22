<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright (c) 2015, Joyent, Inc.
-->

# sdcadm

This repository is part of the Joyent SmartDataCenter project (SDC).  For
contribution guidelines, issues, and general documentation, visit the main
[SDC](http://github.com/joyent/sdc) project page.

`sdcadm` is a tool that lives in the SmartDataCenter headnode's GZ, for
handling SDC post-setup (i.e. setup steps after initial headnode setup),
upgrades, listing of services and instances, health checks, and other SDC setup
duties.

Please see docs/index.md for more details.


# Current status

While `sdcadm` is still under significant development, and is far from complete,
it is currently the recommended way to update SDC. Signs of incompleteness are
that sub-commands of `sdcadm experimental ...` are required as part of the upgrade
process.

Read on for the current recommended SDC post-setup and upgrade procedures.


--

# sdcadm self-update

It's always recommended to run `sdcadm self-update --latest` before performing
any sdcadm upgrade operations, especially because there could be critical
bugfixes published since the last time sdcadm itself was updated.

You can get the exact version of sdcadm running in your SDC setup using:

        sdcadm --version

The output of this command will include both the semver version, and the usual
image version (referencing git branch, date and git SHA). For example:

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

Please note that this command didn't wait for the "add nics" jobs to be
completed, just submitted, so you might need to give it some extra time after
the command exits until these jobs really finish.

## Create CloudAPI VM

If non-administrator access to the SDC setup is planned, the CloudAPI zone must
be created:

    sdcadm post-setup cloudapi


## Add Binder/Zookeeper service cluster to be used by SDC services

By default, an SDC setup runs with a single zookeeper service running in the
`binder` instance. This is not the recommended setup for a production
environment; instead, it's recommended to create a *"cluster"* of 3 or 5
binder service instances.

In case this is a setup already being used by non-administrator users, it's a
good idea to put the DC in maintenance first
(`sdcadm dc-maint --start`). Then:

    sdcadm post-setup ha-binder \
        --servers=`CN1_UUID` \
        --servers=`CN2_UUID`

This command will create 2 more binder instances, one placed on the CN
identified by CN1\_UUID, and the other CN identified by CN2\_UUID.

If you need to create a cluster of 5 instances, you just need to pass a couple
additional CN UUIDs to this command together with the `--members=4` argument.

Once the binder instances have been configured, and all of them have joined
the *"cluster"*, manatee and moray will be restarted to begin using this
setup immediately.

If you put the DC into maintenance, remember to recover it from such state
by using `sdcadm dc-maint --stop`, unless you want to proceed
with ha-manatee too.


## Create the required manatee instances for HA

When you have one manatee initially, you're in ONE\_NODE\_WRITE\_MODE,
which is a special mode that exists just for bootstrapping. To go
from this mode to a HA setup you'll need at least one more manatee.
However, switching modes is not quite as simple as just provisioning a
second manatee. It involves the following steps:

- create a second manatee instance for you (with manatee-sitter disabled)
- disable the ONE\_NODE\_WRITE\_MODE on the first instance
- reboot the first manatee into multi-node mode
- re-enable the sitter and reboot the second instance
- wait for manatee to return that it's synchronized

After we've gone through this, it'll create a 3rd manatee instance on the
second server you specified to complete manatee HA setup.

Aside all these details, all you need to run is:

        sdcadm post-setup ha-manatee \
        --servers=`CN1_UUID` \
        --servers=`CN2_UUID`

It's always a good idea to run `sdcadm check-health` and `sdc-healthcheck`
once this command has been completed, in order to review that everything
reconnected to manatee/moray successfully.

## Create the desired number of moray instances for HA

Finally, it's desirable to have more than the default single moray instance
for HA. Creation of additional moray instances don't require any special
command, just the standard `sdcadm create` used to create any additional
instance of any service (see docs/index.md for the details).

A recommended setup includes two additional moray instances created on the same
CNs we added the manatees on the previous step:

    sdcadm create moray --server=CN1_UUID
    sdcadm create moray --server=CN2_UUID

And that's it. With this, we should have a setup with multiple binder,
manatee and moray instances, ready to operate with HA. As an additional step,
if you plan to give access to non-administrator customers to your SDC setup
(i.e. if you've installed CloudAPI), it would be handy to also have several
mahi instances for HA. You can create them, and in general any additional
instances for services "HA Ready", using the same procedure as for moray:

    sdcadm create mahi --server=CN1_UUID
    sdcadm create mahi --server=CN2_UUID

--

# Manage SDC upgrades with sdcadm

The document [docs/update.md] provides a detailed description on how to
proceed with the update of a given SDC standup. The following are a set
of tips you should consider reading before proceeding with such update
process.

## Verify that we can perform the updates using sdcadm

Any SDC setup must fulfil some requirements in order to be updateable using
`sdcadm`: the VMs for the different SDC services must be past the **minimal
versions** detailed at `etc/defaults.json` under `svcMinImages`. Additionally,
each one of these images imposes a constraint over the minimal platform version
required for the images to work.

The easier way to check if we're past these requirements is to invoke `sdcadm`.
In the case that `sdcadm` finds any issue with any of the services VMs, it will
notify you about the problem. Otherwise, you can continue onto the next step.


## Download everything before running the upgrades

It's a good idea to pre-download all the bits required for an upgrade before
actually going through it. That's the reason we can run the
`sdcadm update` commands with `--just-images` option.

It's also possible to pre-download some images for other SDC components, like
agents or gz-tools, using `sdcadm`. Just proceed as follows:

      sdcadm experimental update-gz-tools --latest --just-download
      sdcadm experimental update-agents --latest --just-download --all

Or, if you want to upgrade to a specific image version instead of the latest
available image:

      sdcadm experimental update-gz-tools <IMG_UUID> --just-download
      sdcadm experimental update-agents <IMG_UUID> --just-download --all


Either way, the `sdcadm experimental` subcommands we mention below should be
able to download and install the required images, or to proceed with the path
given to an image file as documented in `docs/index.md`.

You can download and *"install"* the OS platform for later assignation to
the CNs you want to upgrade by running:

      sdcadm platform install --latest

This will only download and make the platform available for later usage, but
will not assign it to any server.


# Developer notes

## Testing sdcadm

This should only be done by developers, and only in dev or test environments.
Tests will muck around with the sdc setup, doing terrible and unholy things to
your data.

In order to run sdcadm tests, you'll first need to signal to the tests that
you really do want them to run:

    touch /lib/sdc/.sdc-test-no-production-data

After that, to run the tests themselves:

    /opt/smartdc/sdcadm/test/runtests

The full battery of tests can take up to thirty minutes to run. To only run
tests in a single file, instead of all test files, consider using the -f flag
with the `runtests` command. For example, to run the tests in sdcadm.test.js:

    /opt/smartdc/sdcadm/test/runtests -f sdcadm.test.js
