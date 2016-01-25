---
title: Update a SDC standup using sdcadm
markdown2extras: tables, code-friendly, cuddled-lists, link-patterns
markdown2linkpatternsfile: link-patterns.txt
apisections: Updating SDC components, Update of Servers' Platform
---
<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright (c) 2015, Joyent, Inc.
-->


# Update a SDC standup using sdcadm

This document is intended to be used as an example guide of the suggested
procedure to update a SDC DC using `sdcadm`.

The document is divided in two parts:

1. Update of SDC components
2. Update of Servers' Platform

## Section 1: Updating SDC components

### Step 1: self-update sdcadm

    sdcadm self-update --latest

### Step 2: put the DC in maint

NOTE: after performing this step, users of CloudAPI and Docker will not be able to perform write actions until the DC is taken out of maintenance.

    sdcadm dc-maint start

### Step 3: Update agents

In order to know if the latest agentsshar has been installed, run:

    ls -alh /usbkey/extra/agents/|grep $(updates-imgadm list --latest name=agentsshar -o uuid -H)

If there is a new shar, the grep will find nothing, and you'll need to run the following:

    sdcadm experimental update-agents --latest --all --yes

### Step 4: Update docker and hostvolume zones

    sdcadm experimental update-docker --servers=cns,headnode

### Step 5: Update other and gz-tools

    sdcadm experimental update-other
    sdcadm experimental update-gz-tools --latest

### Step 6: Update all other SDC zones

    sdcadm up -y --all --force-data-path

### Step 7: (Optional) Update platforms

If you are going to update the platform in this maint, this is where I usually do it.
Details described in the next section. Otherwise, continue with steps 8-10.

### Step 8: Do a healthcheck

    sdc-healthcheck
    sdcadm health

ensure everything's `online` before taking the DC out of maint.

### Step 9: Take DC out of maint


    sdcadm dc-maint stop


### Step 10: Test!

It's good to at minimum do a:

    docker run -it ubuntu

to ensure that provisioning, starting, and docker attach are all working. If they are, things are probably not too bad.

## Section 2: Updating Servers' Platforms

### Important Prerequisites

The instructions here assume that your manatee primary is on the headnode and
that the manatee sync and async are on separate compute nodes. If this is not
the case, these instructions from step 2 onward will not work for you without
modification.

### Step 1: Update the target platform

Generally this requires doing:


    sdcadm platform remove --all -k 2 --cleanup-cache --yes  # Make some room into the USB Key
    sdcadm platform install --latest
    sdcadm platform assign --latest --all
    sdcadm platform list    # to verify that all 9 are assigned the new platform

Paying attention to any errors. For example: sometimes `sdcadm platform assign` fails to update one or more servers in CNAPI and this command needs to be run again, the `sdcadm platform list` will tell you that this has happened too.


Before proceeding with any of the following steps, you should know the UUID for
the headnode, just in case it hosts the manatee async or sync member. If that's
the case, please refer to Step #7 for headnode reboot.

### Step 2: Find which CN has the manatee async and reboot it

The faster way to get the UUID of the CN hosting the manatee async VM is to
run the following:

    async_vm=$(sdc-login -l manatee 'source ~/.bashrc; /opt/smartdc/manatee/node_modules/.bin/manatee-adm peers -H -r async -o peername')
    async_cn=$(sdc-vmapi /vms/${async_vm}|json -H server_uuid)
    # Reboot the CN and get the Job UUID:
    sdc-cnapi /servers/${async_cn}/reboot -X POST|json -H

This will return the `job_uuid` value for the Job which inits the CN reboot.
After verifying that the aforementioned job succeeded as follows:

    sdc-workflow /jobs/${YOUR_JOB_UUID_HERE}|json execution chain_results

We need to wait for the CN to be rebooted and for the manatee shard to be back
to completely functional status before we continue.

Usually, the simplest way to find if the manatee shard has reached the desired
status is running this within the manatee vm:

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

Note the `0m00s` at the `LAG` column of the `async` line.

### Step 3: Find which CN has the manatee sync and reboot it

The process is exactly the same than the described for the `async` manatee,
but looking for the manatee `sync` peer:

    sync_vm=$(sdc-login -l manatee 'source ~/.bashrc; /opt/smartdc/manatee/node_modules/.bin/manatee-adm peers -H -r sync -o peername')
    sync_cn=$(sdc-vmapi /vms/${sync_vm}|json -H server_uuid)
    # Reboot the CN and get the Job UUID:
    sdc-cnapi /servers/${sync_cn}/reboot -X POST|json -H

And again, check for job success and poll manatee status until the shard is
back to a health state and it has caught up to the latest change:

    sdc-workflow /jobs/${YOUR_JOB_UUID_HERE}|json execution chain_results

    sdc-login -l manatee

    while sleep 5; do manatee-adm show; done

### Step 4: Reboot the remaining CNs

Now that you've rebooted the CNs with the sync and async, you can reboot all the other CNs.
The following is a way to get all the CNs excluding headnode, and the CNs hosting the
manatee `sync` and `async` peers already rebooted into the previous steps.

    # Every setup server from CNAPI:
    all_cns=$(sdc-cnapi /servers|json -Ha uuid|tr '\n' ' ')

    # Remove Headnode and manatee sync and async
    hn=$(sysinfo|json UUID)
    without_async=("${all_cns[@]/$async_cn/}")
    without_sync=("${without_async[@]/$sync_cn/}")

    # The remaining CNs we want to reboot now
    cns=("${without_sync[@]/$hn/}")

    # Proceed with the reboot
    for cn in ${cns[@]}; do sdc-cnapi /servers/${cn}/reboot -X POST; done

and then watch for them all to go running with:

    while sleep 5; do sdc-server list; done

an alternate way to watch for these for cases when above command output seems to be frozen:

    while sleep 5; do echo "--"; sdc-cnapi /servers|json -Ha uuid hostname status transitional_status; done

again. Once they're all running, it's good to run a quick test like provisioning a docker container. I also usually run:

    sdc-oneachnode -a 'echo "$(sysinfo | json UUID) $(uname -v)"'

To ensure that I see all of the CNs on the correct platform.

### Step 5: (Optional) Rebooting the headnode onto the new platform

If there's a reason we need a new platform on the headnode the steps are:

 1. login to the manatee0 zone with `sdc-login -l manatee0`
 2. freeze the manatee cluster with `manatee-adm freeze -r reboot`
 3. verify the cluster is frozen with `manatee-adm show`
 4. reboot the headnode (manatee will be down for writes for the duration)
 5. when the headnode comes back up, login to the manatee0 zone with `sdc-login -l manatee0`
 6. unfreeze the cluster with `manatee-adm unfreeze`
 7. verify the cluster status with `manatee-adm show`

### Step 6: Update Docker logger service


    sdcadm experimental update dockerlogger


### Step 7: Congratulations!

If other maint is complete and the DC is in maint you can take it out of maint with:

    sdcadm dc-maint stop

It would be good to perform the tests suggested on the steps 8-10 of the
previous section at this point, in case you went from there into platform update
section.
