---
title: Triton post-setup with sdcadm
markdown2extras: tables, code-friendly, cuddled-lists, link-patterns
markdown2linkpatternsfile: link-patterns.txt
apisections: 
---
<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright 2017 Joyent, Inc.
-->

# Triton post-setup with sdcadm

The default setup of a Triton DataCenter is somewhat minimal. There are several
post-setup steps required in order to get it configured for practical usage.

## Add external nics to imgapi and adminui

These are required in order to be able to access remote update sources, and in
order to be able to access AdminUI using a browser:

    sdcadm post-setup common-external-nics

Please note that this command didn't wait for the "add nics" jobs to be
completed, just submitted, so you might need to give it some extra time after
the command exits until these jobs really finish.

## Create CloudAPI VM

If non-administrator access to the Triton setup is planned, the CloudAPI zone
must be created:

    sdcadm post-setup cloudapi


## Add Binder/Zookeeper service cluster to be used by Triton services

By default, a Triton setup runs with a single zookeeper service running in the
`binder` instance. This is not the recommended setup for a production
environment; instead, it's recommended to create a *"cluster"* of 3 or 5
binder service instances.

In case this is a setup already being used by non-administrator users, it's a
good idea to put the DC in maintenance first
(`sdcadm dc-maint start`). Then:

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
by using `sdcadm dc-maint stop`, unless you want to proceed
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
if you plan to give access to non-administrator customers to your Triton setup
(i.e. if you've installed CloudAPI), it would be handy to also have several
mahi instances for HA. You can create them, and in general any additional
instances for services "HA Ready", using the same procedure as for moray:

    sdcadm create mahi --server=CN1_UUID
    sdcadm create mahi --server=CN2_UUID

## Setup fabrics

You can setup "fabrics" (Triton's network virtualization system) using the
command:

    sdcadm post-setup fabrics -c /path/to/config.file

where `conf` is a required configuration file. In order to understand the
format of this configuration file there is detailed information about
[fabrics setup in CoaL](https://github.com/joyent/triton/blob/master/docs/developer-guide/coal-post-setup-fabrics.md) and general purpose information on fabrics from the
[Triton networking and fabric operations guide](https://docs.joyent.com/private-cloud/networks/sdn).

### Create portolan HA instances

Once `fabrics` setup has finished and the first `portolan0` instance
has been created into the Headnode, additional HA instances can be
created using `sdcadm create` subcommand:

    sdcadm create portolan --server=CN1_UUID
    sdcadm create portolan --server=CN2_UUID


