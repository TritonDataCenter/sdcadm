---
title: Update a Triton standup using sdcadm
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
    Copyright 2019 Joyent, Inc.
-->


# Update a Triton standup using sdcadm

This document is intended to be used as an example guide of the suggested
procedure to update a Triton DC using `sdcadm`.

The document is divided into three parts:

1. Preparing for the update
2. Updating Triton components
3. Updating server platform

## Section 1: Preparing for the update

The following steps have no user impact and can be performed
before the maintenance window.

## Step 1: Determine the appropriate channel to use

The different `channels` represent the different level of stability
and support for the available software versions. If you are new to
`sdcadm`, you can get a list of the channels using:

    sdcadm channel list

All sdcadm subcommands support the use of the `-C` option for
specifying the channel to use. You can also set a default
channel so that you don't have to specify it every time.
For example, to use the `release` channel by default, you'll run

    sdcadm channel set release

### Step 2: Check for available updates

You can get the information about available system updates using:

    sdcadm avail
    sdcadm platform avail

The first command `sdcadm avail` will include available updates for all
the Triton non-agent services and `sdcadm` itself. The second command
`sdcadm platform avail` will do something similar but, in this case, will
list the available platform images to be installed.

There is a also an experimental version of `sdcadm avail` which includes
the available images for agents:

    sdcadm experimental avail

If you need to look up older versions of the software or components
which are not included in `sdcadm avail`, you can use the `updates-imgadm`
utility. For example:

    updates-imgadm list name=agentsshar | tail -5
    updates-imgadm list name=gz-tools -C dev | tail -3

### Step 3: Get the latest sdcadm

Before performing any upgrade operations, you should first upgrade the
sdcadm utility to the latest version in order to get any critical bug
fixes. To upgrade the sdcadm utility:

    sdcadm self-update --latest

To find out the version of sdcadm running in your Triton setup, run:

    sdcadm --version

The output of this command will include both the semver version, and the usual
image version (referencing git branch, date and git SHA). For example:

    [root@headnode (coal) ~]# sdcadm --version
    sdcadm 1.24.1 (release-20181220-20181220T050440Z-g382c6f1)

### Step 4: (Optional) Download Triton images

To reduce the downtime during upgrade, it's recommended to pre-download all
the bits required before actually performing the update. This can be achieved
by running the `sdcadm update` commands with the `--just-images` option, e.g.

    sdcadm up -y --all --just-images

If you want to upgrade certain components to a specific image version instead
of the latest available image:

First, download all images except for the components in question:

    sdcadm up -y --all --just-images -x vmapi

Then download those components at their target versions by specifying the
version string or image UUID. For example,

    sdcadm up -y vmapi@release-20181206-20181206T015746Z-gdd962af --just-images
    sdcadm up -y vmapi@ba822e92-f8fb-11e8-863a-57352308ad93 --just-images

It is also possible to pre-download the images for other Triton components
such as agents or gz-tools, using `sdcadm`:

    sdcadm experimental update-gz-tools --latest --just-download
    sdcadm experimental update-agents --latest --just-download --all

or

    sdcadm experimental update-gz-tools <GZTOOLS_IMG_UUID> --just-download
    sdcadm experimental update-agents <AGENTSSHAR_IMG_UUID> --just-download --all

There are some optional services that are not part of the agentsshar. If they
are installed in your Triton deployment, you'll need to download their images
and update them separately:

    sdcadm experimental update cmon-agent --just-images    # if cmon is installed
    sdcadm experimental update dockerlogger --just-images    # if docker is installed

If you choose not to pre-download the images to be used for the update, the
`sdcadm update` or `sdcadm experimental update` subcommands will download
the required images on the fly and install them.

### Step 5: (Optional) Download and install platform image

You can download and "install" the OS platform into the USB key by running:

    sdcadm platform install --latest

You can also install a particular platform image by specifying its version
string or image UUID, e.g.

    sdcadm platform install 20181220T002335Z
    sdcadm platform install f9e567c6-7c7d-47e7-9dd1-da422eccdf82

The `sdcadm platform install` step only downloads the image and makes the
platform available for later use, but will not update any server with it.

The platform install can fail if the USB key runs out of capacity. You
can free up some space by removing unused platform images:

    sdcadm platform list    # identify any unused versions for removal
    sdcadm platform remove <VERSION> --cleanup-cache --yes

### Step 6: Put the DC in maintenance

During Triton update or headnode reboot, the services that support
orchestration activities will experience some amount of downtime. It is
recommended to put the datacenter in maintenance so that users of CloudAPI
and Docker will not encounter request failures caused by the outage. They
should still be able to perform `GET` requests (get, list) against most
objects, ssh to existing instances and run workload on them.

To put a DC in maintenance, run:

    sdcadm dc-maint start

The command supports two options: `--message` and `--eta`. For example,

    sdcadm dc-maint start --message='Daily Maintenance Time' --eta=2016-07-07T18:30:00

They are useful for communicating the state of the system to the end users.
The `--message` provided will be included in the HTTP response messages for
orchestration requests. The `--eta` specified will be used in Retry-After
HTTP headers.

### Step 7: (Optional) Back up manatee

If you have a single manatee instead of a HA cluster, you may want to back up
the manatee zone for data recovery purpose.

To back up the zone, take a ZFS snapsnot of the manatee zone and copy it out, e.g.

    MANATEE0_UUID=$(vmadm lookup -1 alias=~manatee)
    zfs snapshot zones/$MANATEE0_UUID/data/manatee@backup
    zfs send zones/$MANATEE0_UUID/data/manatee@backup > /var/tmp/manatee-backup.zfs
    zfs destroy zones/$MANATEE0_UUID/data/manatee@backup


## Section 2: Updating Triton components

### Step 1: Update agents

To confirm if the latest agentsshar has been installed, you can run:

    ls -alh /usbkey/extra/agents/|grep $(updates-imgadm list --latest name=agentsshar -o uuid -H)

If the agentsshar is already up to date, the grep will return nothing.

Once you are ready to update the agents, execute the following command:

    sdcadm experimental update-agents --latest --all --yes
    sdcadm experimental update cmon-agent --all    # if cmon is installed
    sdcadm experimental update dockerlogger --all    # if docker is installed

### Step 2: Update other and gz-tools

    sdcadm experimental update-other
    sdcadm experimental update-gz-tools --latest

Note that `update-other` will have no effect if we haven't updated `sdcadm` itself.

### Step 3: Update all other Triton service instances

It's possible to upgrade all Triton service instances at once by running:

    sdcadm up -y --all --force-data-path

A better approach to upgrading Triton services is to break the process into
multiple steps, and postpone the update of services that are depended on
by other services. These key services, in the recommended order of update,
are: `sapi`, `moray`, `binder` and `manatee`.

Here are the set of commands to execute for the multi-step approach:

    sdcadm up -y --all --force-data-path -x sapi -x moray -x binder -x manatee

    # run `sdcadm health` between commands to make sure we can move forward

    sdcadm up sapi -y

    sdcadm up moray -y

    sdcadm up binder -y

    sdcadm up manatee -y

After executing all of the sdcadm commands, the user can verify the versions of
the Triton components and agents by running:

    sdcadm instances -o "type,service,hostname,version,image,alias"

### Step 4: (Optional) Update headnode platform image

At this point in the process, if you also plan to update the platform
image on the headnode or servers that host any of the HA Triton services,
follow the instructions in the next section. Otherwise, continue with
steps 5-7.

### Step 5: Perform health check

Ensure everything is `online` before taking the DC out of maintenance
by running:

    sdc-healthcheck
    sdcadm health

### Step 6: Take DC out of maintenance

    sdcadm dc-maint stop

### Step 7: Test!

At a minimum you should test some provisioning requests:

    triton instance create <IMG_NAME> <PKG_NAME>
    docker run -it ubuntu    # if docker is deployed

and confirm that provisioning, starting, and docker attach are all working.
If they are, the stack should be relatively healthy. You may also want to
verify other key features that are applicable to your deployment (e.g. create
image from VM, fabric network connectivity, cmon metrics availability).


## Section 3: Updating server platform

### Important prerequisites

Server platform upgrade can be disruptive but you can mitigate the outage
of applications running on the servers by having mechanisms for failover
and rebooting your servers in a controlled fashion.

Skip to Step 1 below if you do not have Manta deployment.

If you have Manta deployed in the datacenter, you can expect some shards to
go through failover during reboots unless the shards are already frozen.
Rebuild of the deposed primaries may be required afterwards (more explanation
about manatee failover and rebuild can be found in step 2 below when we talk
about how to plan reboots of servers running manatee).

If downtime can be tolerated for Manta, you can simply freeze all the
shards before the reboots by running:

    manta-oneach -s postgres 'manatee-adm freeze -r reboot'

    # and unfreeze them at the end with:
    manta-oneach -s postgres 'manatee-adm unfreeze'

else, you can follow the same approach as outlined in step 2 to orderly
reboot the Manta CNs. However that approach is feasible only if each CN
runs a single manatee instance or instances with identical shard roles.

### Step 1: Set boot platform to the target version

If you have not installed the platform image yet, run the following:

    sdcadm platform install --latest

Assign the platform image to all the servers, including the headnode:

    sdcadm platform assign <PI_VERSION> --all
    sdcadm platform list    # verify that all CNs has the correct boot platform

Pay attention to any errors. For example, sometimes `sdcadm platform assign` fails
to update one or more servers in CNAPI and the command will need to be rerun. The
`sdcadm platform list` will also allow you to catch that.

If the `BOOT_PLATFORM` count for the new platform version is less than expected,
you can find out which servers did not have the platform staged with:

    sdc-cnapi /servers | json -aH hostname uuid boot_platform | grep -v <PI_VERSION>

### Step 2: Plan the sequence of CN reboot

Identify the headnode UUID and the CN UUIDs that host the manatee cluster.

    hn=$(sysinfo|json UUID)
    prmy_vm=$(sdc-login -l manatee 'source ~/.bashrc; /opt/smartdc/manatee/node_modules/.bin/manatee-adm peers -H -r primary -o peername')
    prmy_cn=$(sdc-vmapi /vms/${prmy_vm}|json -H server_uuid)
    sync_vm=$(sdc-login -l manatee 'source ~/.bashrc; /opt/smartdc/manatee/node_modules/.bin/manatee-adm peers -H -r sync -o peername')
    sync_cn=$(sdc-vmapi /vms/${sync_vm}|json -H server_uuid)
    async_vm=$(sdc-login -l manatee 'source ~/.bashrc; /opt/smartdc/manatee/node_modules/.bin/manatee-adm peers -H -r async -o peername | head -1')
    async_cn=$(sdc-vmapi /vms/${async_vm}|json -H server_uuid)
    echo "  Headnode: ${hn}"$'\n'"  Primary : ${prmy_cn}"$'\n'"  Sync    : ${sync_cn}"$'\n'"  Async   : ${async_cn}"

If you intend to reboot all servers (*including* the headnode) into the new
platform, the recommended reboot sequence is:

| Step | Type of server |
| ---- | -------------- |
| 3 | server with the first manatee "async" (i.e. downstream peer of "sync") |
| 4 | servers with all other manatee "async" and servers without any manatee |
| 5 | server with manatee "sync"                                             |
| 6 | server with manatee "primary"                                          |
| 7 | headnode (if it is not already covered above)                          |

Note that it is possible to have multiple async manatee peers. For the
purpose of reboot planning, we will focus on rebooting the first async
peer. Subsequent peers can be rebooted along with non-manatee servers.

If you want to avoid rebooting the headnode, then identify the manatee role
of the peer that resides in the headnode, and skip the corresponding reboot
step below. For example, if the headnode and manatee async CN are the same
server, you'll skip step 3.

### Step 3: Reboot the server which has the first manatee 'async'

    # Reboot the CN and get the Job UUID:
    sdc-cnapi /servers/${async_cn}/reboot -X POST|json -H

The CNAPI call will return the `job_uuid` value for the job which
initiates the CN reboot.

After verifying that the aforementioned job succeeded as follows:

    sdc-workflow /jobs/${YOUR_JOB_UUID_HERE}|json execution chain_results

We need to wait for the CN to boot up and for the manatee shard to be back
to completely functional status before we continue.

Usually, the simplest way to find if the manatee shard has reached the desired
status is running this within any of the manatee instances:

    sdc-login -l manatee
    while sleep 5; do manatee-adm show; done

For example:

    [root@0188b19a-a578-4ba3-9565-5b0cb73a9c99 (us-east-3b:manatee0) ~]# while sleep 5; do manatee-adm show; done
    zookeeper:   10.10.64.23
    cluster:     sdc
    generation:  93 (62/1A296448)
    mode:        normal
    freeze:      not frozen

    ROLE     PEER     PG   REPL  SENT          FLUSH         REPLAY        LAG
    primary  0188b19a ok   sync  69/11137A08   69/11137A08   69/11125180   -
    sync     67f1e64c ok   async 69/11137A08   69/11137A08   69/11125180   -
    async    74940324 ok   -     -             -             -             0m00s
    ^C
    [root@0188b19a-a578-4ba3-9565-5b0cb73a9c99 (us-east-3b:manatee0) ~]#

Note the `0m00s` at the `LAG` column of the `async` line. `LAG` represents
how far the sync and async are lagging behind the upstream peer. Failover
cannot commence until the downstream peer has caught up on updates. A lag
of a few seconds is generally not a problem. When in doubt, re-check the
shard status until the lag is close to zero.

### Step 4: Reboot servers with all other manatee "async" and servers without any manatee

The following is a way to get all the CNs, excluding headnode and the CNs hosting the
manatee peers.

    # Every setup server from CNAPI:
    all_cns=$(sdc-cnapi /servers|json -Ha uuid|tr '\n' ' ')

    # Remove CNs with manatee peers
    without_async=("${all_cns[@]/$async_cn/}")
    without_sync=("${without_async[@]/$sync_cn/}")
    without_prmy=("${without_sync[@]/$prmy_cn/}")

    # Remove HN, in case it's still on the list
    cns=("${without_prmy[@]/$hn/}")

    # Proceed with the reboot
    for cn in ${cns[@]}; do sdc-cnapi /servers/${cn}/reboot -X POST; done

Now watch for them to return to 'running' status:

    while sleep 5; do sdc-server list; done

or

    while sleep 5; do echo "--"; sdc-cnapi /servers|json -Ha uuid hostname status transitional_status; done

Once they're all up and running, run a quick test such as provisioning a docker container.
You can also run:

    sdc-oneachnode -a 'echo "$(sysinfo | json UUID) $(uname -v)"'

to confirm that all of the CNs are on the correct platform image version.

### Step 5: Reboot the server which has the manatee 'sync'

During the reboot, manatee will go through failover to swap
the roles between the 'async' and 'sync' peers. Manatee will be
down for writes for the duration of the failover.

    # Reboot the CN and get the Job UUID:
    sdc-cnapi /servers/${sync_cn}/reboot -X POST|json -H

Again, check for the successful job completion and poll manatee status
until the shard is back to healthy state and has caught up:

    sdc-workflow /jobs/${YOUR_JOB_UUID_HERE}|json execution chain_results

    sdc-login -l manatee

    while sleep 5; do manatee-adm show; done

### Step 6: Reboot the CN which has the manatee 'primary'

Manatee will be down for writes for the duration of the reboot.
There are two ways to handle the primary manatee downtime:

 1. let manatee cluster go through failover (i.e. depose current
    primary, promote sync to primary and async to sync)
 2. freeze manatee cluster ahead of reboot and accept the downtime

Failover is a better option if the primary peer does not reside
on the headnode and you want to minimize the orchestration downtime.
At the end of the reboot, you will need to rebuild the original
'primary' as the new 'async'.

If the primary is on the headnode *and* you are upgrading the headnode,
the manatee downtime will not add to the overall orchestration outage.
In this case, we can simply freeze the cluster:

    sdc-login -l manatee
    manatee-adm freeze -r reboot
    # Verify that the cluster is frozen
    manatee-adm show

Now proceed with reboot:

    sdc-cnapi /servers/${prmy_cn}/reboot -X POST|json -H

Check for the successful job completion and poll manatee status
until the shard is back to healthy state and has caught up:

    sdc-workflow /jobs/${YOUR_JOB_UUID_HERE}|json execution chain_results

    sdc-login -l manatee

    while sleep 5; do manatee-adm show; done

If you have previously frozen the cluster, unfreeze it with

    manatee-adm unfreeze

If you have a deposed peer, you can rebuild it with

    manatee-adm rebuild

Finally verify the cluster status with `manatee-adm show`.

### Step 7: Reboot the headnode if it has not been covered yet

The headnode normally has one of the manatee peers and should have
been rebooted in one of the steps above. In case it is not already
rebooted and you intend to upgrade its platform as well, you can
simply issue a reboot from the headnode.


### Step 8: Perform health check

If there are no other pending updates, you can execute steps 5-7 in
the "Updating Triton Components" section to perform health checks and
take the DC out of maintenance (if it was previously put in maint).

If the datacenter has a Manta deployment, you can now unfreeze shards
that have been frozen for the reboot. You should also perform additional
health checks, for example:

    manta-oneach -a 'svcs -xv'
    manta-oneach -G -s storage mrzones
    manta-oneach -s postgres 'manatee-adm verify -v'
