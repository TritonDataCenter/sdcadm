---
title: sdcadm (Administer a SDC standup)
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
    Copyright (c) 2014, Joyent, Inc.
-->

# sdcadm

`sdcadm` is a tool intended for managing SDC config, core services and
instances. I.e. It is responsible for setting up, upgrading, creating optional
instances (e.g. cloudapi), making services HA, etc.


# Current Status

In active development, not yet complete. See the [sdc-update project
plan](https://mo.joyent.com/docs/engdoc/master/roadmap/projects/sdc-update.html).
The current SDC upgrade process is still via the [incr-upgrade
scripts](https://github.com/joyent/sdc-headnode/blob/master/incr-upgrade-scripts/README.md),
which `sdcadm` intends to replace.

# Commands

This section describes the basic design/plan for each of the sdcadm commands.
Consult the online docs, i.e. `sdcadm help <subcommand>`, for the most authoritative
docs. The docs here are from the design stage so could be out of date.


## sdcadm instances

Lists all SDC instances (core zones, agent deployments, etc.). Something like:

    [root@headnode (coal) ~]# sdcadm insts
    SERVICE          HOSTNAME  IMAGE/VERSION                           ZONENAME                              ALIAS
    adminui          headnode  c77c6170-c684-11e3-a923-f70fb5d07369    4b25e075-417b-431a-b714-64d71af11482  adminui0
    amon             headnode  ca24dee8-c666-11e3-bf00-4f6cfefc1a5f    770f1118-ef8d-485d-b8d4-995c2b2176dc  amon0
    amonredis        headnode  c573c53a-c59e-11e3-9127-535b051b6fa0    7e3b1de5-fa05-4e30-8d6c-2cf3944ea0e3  amonredis0
    assets           headnode  d8c432fe-c667-11e3-b488-33d233e7ce30    4074bfc0-9736-4b01-b54e-f5e8cd813588  assets0
    binder           headnode  f9ae21ae-c668-11e3-94db-e7b0bd3f7d06    7de9fcbe-16c8-4138-ba31-fc24b9bd17de  binder0
    ca               headnode  41a93886-c664-11e3-90e0-8b1841a582e9    a2cb3d39-41c6-498a-a03b-04dc6eb5d95c  ca0
    ...
    provisioner      headnode  2.3.0                                   -                                     -
    smartlogin       headnode  0.1.0                                   -                                     -
    zonetracker      headnode  1.0.1                                   -                                     -


## sdcadm services

List all SDC services. It shows unique "(service, image)" combinations.
Something like:

    [root@headnode (us-beta-4) ~]# sdcadm svcs
    SERVICE          IMAGE                                 VERSION                                 COUNT
    ...
    imgapi           0ac605e2-66b0-4789-e4ed-de0f25042f34  master-20140317T224857Z-g6e0633c        1
    manatee          187f8a96-bea3-11e3-ba5e-13daee91cc4e  master-20140407T221703Z-g41f2155        3
    moray            a3fca478-bb83-11e3-896b-ff991348bad0  master-20140403T225148Z-geb8db23        2
    napi             4a8850d2-1874-c8fe-bc14-9231690d49e6  master-20140227T193003Z-g66705ce        1
    ...
    cabase           -                                     1.0.3vmaster-20131204T194515Z-gd1e3e5b  1
    cabase           -                                     1.0.3vmaster-20140220T230929Z-gaa19d5c  3
    cainstsvc        -                                     0.0.3vmaster-20131204T194515Z-gd1e3e5b  1
    cainstsvc        -                                     0.0.3vmaster-20140220T230929Z-gaa19d5c  3
    ...

Similar to some `manta-adm show` forms.


## sdcadm self-update

Find the latest `sdcadm` image in updates.joyent.com, download it and install.

It's always recommendable to run `sdcadm self-update` before to perform any
sdcadm upgrade operation, specially because there could be critical bugfixes
published since the last time sdcadm itself was updated.

You can get the exact version of sdcadm running into your SDC setup using:

        sdcadm --version

The output of this command will include both, the semver version, and the usual
image version, referencing git branch, date and git SHA. For example:

        [root@headnode (coal) ~]# sdcadm --version
        sdcadm 1.3.9 (master-20141114T063621Z-g995ee7e)

## sdcadm update

The command to update SDC instances (core zones, agents, etc.). A simple
example would be updating one of the stateless core zones to the latest
available image, e.g.:

        sdcadm update cnapi

which will result in the following steps:

- find the latest cnapi image (these are the "changes")
- create /var/sdcadm/updates/$timestamp/plan.json (the "plan"), this is the
  updated `sdcadm instances -j` state.
- confirm changes
- execute plan.json (details on how particular services are upgraded is
  discussed later)
- note the update in its history (in a 'sdcadm\_history' bucket in moray)

Calling forms:

    sdcadm update <svc> [<svc> ...]
        Where '<svc>' is just the name, e.g. 'cnapi', for the latest
        available. Or 'cnapi@1.2.3' for that version (or latest of that ver
        if multiple images with that ver). Or 'cnapi@UUID' for a specific
        cnapi.
    sdcadm update <inst> [<inst> ...]
        Where '<inst>' is a specific instance (per `sdcadm insts`),
        e.g. 'cnapi0'.  Useful for e.g. testing interactions and
        perhaps for dev. Perhaps for upgrading agents on a single CN.
        Not yet implemented. See TOOLS-723.
    ... upgrade-spec ... | sdcadm update
    sdcadm update -f <./local-upgrade-file.json>
        Upgrade a set of services (or instances) per a simple changes JSON
        format. This mirrors the "upgrade-images" file in current
        incr-upgrade scripts
        (https://mo.joyent.com/usb-headnode/blob/master/incr-upgrade-scripts/README.md).
        This could also be useful for airgap upgrades provided to customers on
        some media: a tarball of images with a "update.json".
            [
                {"service": "cnapi", "image": "<uuid-or-local-path>"},
                {"service": "provisioner", "image": "<uuid-or-local-path>"}
                ...
            }
        Can also pass in this payload on stdin, e.g.:
            echo '{
                "service": "cnapi",
                "image": "11f2be78-fc8c-e556-bc01-ecdbc3fb4e66"
            }' | sdcadm update
    sdcadm update -a|--all
        Update all services to the latest available image.
    sdcadm update --plan <path>
        Update everything in SDC to match this plan file. Could be useful
        for an eventual 'sdcadm setup' taking over HN setup from headnode.sh.
        Also, this maps to `manta-adm update`'s design.

There are more examples below that also cover cases like adding a new
instance of a service, or deleting one.

#### REVIEW: Development note:

A note on SAPI /instances. I'm proposing that /instances change to be a
reflection of actual state (core zones from VMAPI
ListVms?owner\_uuid=$admin&tags.smartdc\_role, current deployed agents from CNAPI
ServerList?extras=sysinfo) rather than its current possible split brain set
of instances. We should maintain the ability to have special SAPI metadata
defined on an instance (my understanding is this is rare, tho at least one
use case for ONE\_NODE\_WRITE\_MODE for manatee).

### How to search for available updates?

At the moment of writting the current doc, the only way to search for available
updates for a given service is using `updates-imgadm`, and compare the results
with the service/instance image version provided, for example, by either
`sdcadm services` or `sdcadm instances`.

Of course, you don't need to go through `updates-imgadm` step if your goal is
to just upgrade to the latest available image of such service.

There are couple things to note regarding available updates and future `sdcadm`
development stages:

- In the short term, **update channels**, already available for `updates-imgadm`
  will be included into `sdcadm update`, allowing users to pick the right channel
  for each setup from: development, staging, releases, ...
- During upcoming iterations, the command `sdcadm avail` will be also
  implemented.

In the meanwhile, if you want to search for available updates for a given
service, you can find the *"non obvious image names"* for all the services using:
`cat /opt/smartdc/sdcadm/etc/defaults.json | json imgNameFromSvcName`.

#### FUTURE: 'sdcadm update' failure.

Because we generate a target plan.json, we can have a
`sdcadm update --retry|--resume|--whatever` that will re-confirm and
execute the "plan.json" from the latest upgrade attempt.

## sdcadm create

Create an instance for an existing SDC service.

        sdcadm create <svc> --server=<UUID>

Note that in order to create an instance of some services the option
`--skip-ha-ready` must be specified, given that those services are not
supposed to have more than one instance. When trying to create a new
instance of one of these services, sdcadm will let you know that you should
provide this flag.

There are also some services which are not allowed to have more than one
instance, like sdc, or services whose instances should not be created
using this tool, like manatee or zookeeper.

Finally, the first instance of some services should not be created using this
tool when there is an alternate choice provided by `sdcadm post-setup`
subcommand.

### 'sdcadm update/create' examples

Update a service (all instances):

    sdcadm update cnapi
    sdcadm update cnapi@11f2be78-fc8c-e556-bc01-ecdbc3fb4e66

which is a shortcut for:

    # Upgrade all instances in the 'cnapi' service to the given image.
    echo '{
        "service": "cnapi",
        "image": "11f2be78-fc8c-e556-bc01-ecdbc3fb4e66"
    }' | sdcadm update

    # Or, just upgrade a particular instance, as follows. Here 'alias' or
    # VM 'uuid' is sufficient to unique identify a "zone" instance.
    $ echo '{
        "alias": "dapi0",
        "image": "11f2be78-fc8c-e556-bc01-ecdbc3fb4e66"
    }' | sdcadm update

    # or this:
    $ echo '{
        "uuid": "a8f5bd32-c24d-374b-b668-3f6e1349ddaa",
        "image": "11f2be78-fc8c-e556-bc01-ecdbc3fb4e66"
    }' | sdcadm update

    # Or a particular *agent* is identified by server (or hostname) and
    # service name (i.e. the agent name).
    $ echo '{
        "server": "headnode",
        "service": "provisioner",
        "image": "11f2be78-fc8c-e556-bc01-ecdbc3fb4e66"
    }' | sdcadm update

Add a new cnapi instance:

    $ echo '{
        "create": true,
        "image": "11f2be78-fc8c-e556-bc01-ecdbc3fb4e66",
    }' | sdcadm update
    sdcadm update: error (SomeCode): must specify 'server' (or 'hostname') for a new instance

    $ echo '{
        "create": true,
        "image": "11f2be78-fc8c-e556-bc01-ecdbc3fb4e66",
        "hostname": "headnode"
    }' | sdcadm update
    Provision new instance: $uuid (dapi1, service 'cnapi', image $image_uuid, server $server_uuid)

    # Or the same to 'sdcadm create' (tho the 'create': true is implied there)
    $ echo '{
        "image": "11f2be78-fc8c-e556-bc01-ecdbc3fb4e66",
        "hostname": "headnode"
    }' | sdcadm update
    Create new zone: $uuid (dapi1, service 'cnapi', image $image_uuid, server $server_uuid)

    # Create cloudapi
    sdcadm create cloudapi -s $server_uuid
    sdcadm create cloudapi -H $hostname
    sdcadm create -H headnode cloudapi

Agent examples:

    sdcadm update provisioner    # update provisioner on *all* CNs
    sdcadm update -s SERVER,SERVER,SERVER -s SERVER provisioner \
        -i IMAGE

Perhaps we add a '-c COND' predicate for which servers to include/exclude
a la `json -c COND ...`? Or clearer to have `sdcadm cn -n <filters...>`
for that a la `manta-adm cn -n ...`.


## sdcadm rollback

Rollback one or more service images to the versions they were at before
applying the given plan update.

    sdcadm rollback -f <./local-upgrade-file.json> --force

In order to rollback one or more services to the version these services
were before a given update, it's necessary to pass the `plan.json` file
generated for such update, (plan files are usually at
`/var/sdcadm/updates/$buildstamp`). `sdcadm` will figure out the previous
version for those services using this file, and generate a new plan for
the rollback process.

Right now there are no restrictions at all about what version a given
service can be rolled back to, (if you can update a service to a given
version, you can rollback a service to that same version).

Please, take into consideration that we're not making any check regarding
service irreversible migrations at the moment. This is the reason you
must specify the `--force` flag, in order to confirm that you want to
rollback the services/instances listed into the provided plan file, despite
of the possible issues this may cause with specific service migrations.

## sdcadm history

        [root@headnode (coal) ~]# sdcadm history
        UUID                                  STARTED                   FINISHED                  CHANGES                  ERROR
        468b565d-9a26-47d2-8036-aba4facff106  2014-12-04T08:30:08.417Z  2014-12-04T08:30:09.903Z  service(sdcadm)          -
        2be86246-4abc-4e92-b338-9fcb3f01708c  2014-12-03T18:01:19.385Z  2014-12-03T18:10:34.960Z  update-service(adminui)  -
        418e3cdc-0607-4b85-b698-e851a1e2599a  2014-12-03T17:53:47.394Z  2014-12-03T17:55:15.131Z  create(moray)            -
        aa9beb7d-13c5-4956-98d1-59450fe9bb68  2014-12-03T16:57:54.339Z  2014-12-03T16:59:09.883Z  add-instance(cloudapi)   -

We keep a history of updates in a 'sdcadm\_history' moray bucket.
This command lists the history a la `zpool history` ( with
tabular output). In case moray happens to be down, history for an upgrade
is cached locally and pushed to Moray on later uses of sdcadm.

During a `sdcadm update` there is a two phase write to the history: first at
the start of the update before changes are made, and later on completion.
We attempt to write that completion even when the update failed, but the
initial write at the start allows for detection of update *crashes*.

The same thing happens for other commands like `sdcadm self-update`,
`sdcadm post-setup zookeeper` or `sdcadm post-setup cloudapi`. In general,
any sdcadm subcommand causing a modification of the system will call history
and save such change into the aforementioned 'sdcadm\_history' bucket.

The `-j|--json` option allows retrieving such changes in raw
JSON format (with the same structure than update plan.json). Finally, if
the UUID of a given change is given as an argument to `sdcadm history`,
only that change, using JSON, will be retrieved:

        [root@headnode (coal) ~]# sdcadm history aa9beb7d-13c5-4956-98d1-59450fe9bb68
        {
            "uuid": "aa9beb7d-13c5-4956-98d1-59450fe9bb68",
            "changes": [
                {
                    "image": {
                    ...
                    },
                    "service": {
                        "uuid": "e78ed5c4-2fc9-4eaf-b01f-69d125ab3389",
                        "name": "cloudapi",
                        "application_uuid": "060bfa19-4311-4c05-a6c1-17992adcd35f",
                        "params": {
                        ...
                        }
                        "type": "vm"
                    },
                    "type": "add-instance",
                    "inst": {
                        "type": "vm",
                        "alias": "cloudapi0",
                        "version": "master-20141202T130707Z-gd56fde9",
                        "service": "cloudapi",
                        "image": "2ab47008-7a25-11e4-857d-b771410898a7",
                        "uuid": "0af28cf9-4c8b-4146-8a4d-f93f21bcea17",
                        "zonename": "0af28cf9-4c8b-4146-8a4d-f93f21bcea17"
                    }
                }
            ],
            "started": 1417625874339,
            "finished": 1417625949883
        }

It's also possible to just search for history items started right after,
(`--since`) or before (`--until`) the given date. Both command options take
a valid ISO 8610 Date String as their possible values. Of course, a combination
of both command options will allow to search withing a given time interval.

## sdcadm check-health

Checks that SDC services (and instances) are healthy, i.e., SDC services
either on the Global Zone or in the SDC vms are up and running.

    [root@headnode (coal) ~]# sdcadm check-health
    INSTANCE                                              SERVICE          HOSTNAME  ALIAS       HEALTHY
    c3d3ed4e-86e5-4d84-b705-85192febaf48                  adminui          headnode  adminui0    true
    30db9c5f-024c-4ade-8cdc-43d74656e03f                  amon             headnode  amon0       true
    88540141-cabb-4910-86c0-bf1435b8e40d                  amonredis        headnode  amonredis0  true

When given a service or instance UUID, only the information for such service
will be displayed.

## sdcadm check-config

Verifies that the configuration values in SAPI for the `sdc` application are
correct and match the values existing on the system. If any of these values
isn't as expected, the command will emit an error.

        [root@headnode (coal) ~]# sdcadm check-config
        All good!

You can get a detailed list of which values are checked by running:

        sdc-sapi /applications?name=sdc | json -Ha

#### FUTURE: Add the ability to edit SDC configuration using sdcadm. Both,
at SAPI level and USB key config.

## sdcadm post-setup

The default setup of a SmartDataCenter headnode is somewhat minimal.
"Everything up to adminui." Practical usage of SDC -- whether for production,
development or testing -- involves a number of common post-setup steps. This
command attempts to capture many of those for convenience and consistency.

At the moment, the following are the sdcadm **sub-commands available** for
SDC post-setup tune up:

- `cloudapi`: Create the first CloudAPI instance.
- `common-external-nics`: Add external NICs to `imgapi` and `adminui`
  instances. Required to run any sdcadm command involving remote source images.
- `zookeeper`: Create a *"cluster"* of zookeeper instances, and configure
  all the SDC services to use them.
- `ha-manatee`: Create the 2nd and 3rd manatee instances, required for manatee
  HA.


### sdcadm post-setup common-external-nics

In order to be able to import images from the SDC update channels, the `imgapi`
instance needs to have an external NIC, which is not created by default when
SDC headnode is setup. Until such NIC is added, any attempt to run any of the
sdcadm operations performing requests to such remote source of upgrades will
result in an error message like the following:


      Error importing image <UUID> (<svc>@<version>)

      There is an error trying to download images due to the lack of imgapi external nic.
      Please, run:

          `sdcadm post-setup common-external-nics`

      and try again.

Running the sub-command is pretty simple:

        [root@headnode (coal) ~]# sdcadm post-setup common-external-nics
        Added external nic to adminui
        Added external nic to imgapi

Please, note that while the command itself will exit pretty quickly, there will
be two jobs queued to add those NICs, both of them involving a reboot of each
one of these instances. Therefore, it's very convenient to wait for some time
in order to give these jobs some time to be completed.

#### Additional information

In the future, it's very likely that this command will be modified in order to
poll for Job's completion. In the meanwhile, it's possible to get the UUIDs of
the Jobs associated with these NICs addition looking at sdcadm post-setup logs,
usually available at:

        /var/log/sdcadm/logs/<SOME-NUMBERS>-post-setup.log

Just search the log files for something like:

        [2014-12-01T15:43:17.303Z] TRACE: sdcadm/post-setup/76103 on headnode: (req_id=82788868-3109-4936-b4f4-df024639115c)
            body received:
            {"vm_uuid":"eca3f83d-975c-4fb9-83c1-44906536c876","job_uuid":"e040ea27-f6e5-4b1c-82dd-710ff10a6cf8"}
        [2014-12-01T15:43:17.303Z] DEBUG: sdcadm/post-setup/76103 on headnode: Added external nic to imgapi (req_id=82788868-3109-4936-b4f4-df024639115c, progress=true)

and then just poll the workflow job as documented:

        [root@headnode (coal) ~]# sdc-workflow /jobs/e040ea27-f6e5-4b1c-82dd-710ff10a6cf8|json -H execution

until it switches from `queued` or `running` to either `suceeded` or any
failure state.

### sdcadm post-setup cloudapi

Initial setup of SmartDataCenter does not create a cloudapi instance. You need
to create it using this command if you want to allow SDC users to create
instances using unprivileged accounts, i.e., without using AdminUI.

        [root@headnode (coal) ~]# sdcadm post-setup cloudapi
        cloudapi0 zone created

Contrary to `post-setup common-external-nics`, this command will wait until the
`cloudapi` instance has been created and it's ready.

Please, note that you shouldn't try to create first cloudapi instance and,
in general, the first instance of any service using `sdcadm create` but
instead, you should use the specific tools provided to add these services,
since each service may need its own specific sets of custom parameters.

### sdcadm post-setup zookeeper

By default, SDC comes with a single zookeeper service instance running into the
binder instance. While this initial setup is perfectly fine for development,
it's recommended to update it to a *"cluster"* of zookeeper instances, each of
them running into a different compute node, as the first step towards SDC HA.

In addition to the usual `-y` and `-h` options, the `sdcadm post-setup zookeeper`
sub-command takes the following notable options:

- `i|image`: UUID of the specific image to use. The latest available image by
  default.
- `m|members`:  The number of instances to create (3 or 5). Default: 3
- `s|servers`:  The UUID for the target servers. At least (m - 1) are required,
  since the first zookeeper instance will be created on the headnode.


        [root@headnode (coal) ~]# sdcadm post-setup zookeeper \
        --servers=`564dc9e5-fcb0-fed8-570d-ca17753dd0cc` \
        --servers=`3254278b-34f6-4b89-a749-49dbdfe0795f`


#### Current Status: Waiting on MANATEE-243.

### sdcadm post-setup ha-manatee

Create 2nd and 3rd manatee instances as a required step for HA.

When you have one manatee initially, you're in ONE\_NODE\_WRITE\_MODE
which is a special mode that exists just for bootstrapping. To go
from this mode to a HA setup you'll need at least one more manatee.
Switching modes however is not quite as simple as just provisioning a
second one. This command attempts to move you from one instance to a
HA setup.

After examining your setup and ensuring you're in the correct state
it will:

- create a second manatee instance for you (with manatee-sitter disabled)
- disable the ONE\_NODE\_WRITE\_MODE on the first instance
- reboot the first manatee into multi-node mode
- reenable the sitter and reboot the second instance
- wait for manatee to return that it's synchronized

After we've gone through this, it'll create a 3rd manatee instance
 on the second server you specified to complete manatee ha setup.


        sdcadm post-setup ha-manatee \
        --servers=`564dc9e5-fcb0-fed8-570d-ca17753dd0cc` \
        --servers=`3254278b-34f6-4b89-a749-49dbdfe0795f`

As you've seen, two `servers` must be specified, one for each manatee
instance to be created.

### sdcadm post-setup ha-moray

While adding more than a single moray zone is necessary in order to provide
real HA for your SDC data, there's no need to add a special command in order
to setup more than the default **moray** instance. You can add as many of them
as you need by using `sdcadm create moray --server=UUID`.


## sdcadm experimental command

The following are a set of temporary commands used as replacement of some of
the [incr-upgrade
scripts](https://github.com/joyent/sdc-headnode/blob/master/incr-upgrade-scripts/README.md)
which will be eventually integrated into `sdcadm update --all` or moved into
different sdcadm sub-commands. In the meanwhile, the following is the list
of these experimental sub-commands involved into SDC update tasks.

## sdcadm experimental dc-maint

Show and modify the DC maintenance mode.

"Maintenance mode" for an SDC means that Cloud API is in read-only mode.
Modifying requests will return "503 Service Unavailable". Workflow API will
be drained on entering maint mode.

Limitation: This does not current wait for config changes to be made and
cloudapi instances restarted. That means there is a window after starting that
new jobs could come in.

Usage:

     sdcadm experimental dc-maint [-j]           # show DC maint status
     sdcadm experimental dc-maint [--start]      # start DC maint
     sdcadm experimental dc-maint [--stop]       # stop DC maint


## sdcadm experimental install-platform

Download and install platform image for later assignment.

Usage:

     sdcadm experimental install-platform IMAGE-UUID
     sdcadm experimental install-platform PATH-TO-IMAGE
     sdcadm experimental install-platform --latest

Remember that you can get a list of available platform images from your
updates channel by running:

    updates-imgadm list name=platform

## sdcadm experimental assign-platform

Assign platform image to the given or all SDC servers.

Usage:

     sdcadm experimental assign-platform PLATFORM SERVER_UUID
     sdcadm experimental assign-platform PLATFORM --all

Logically, this command needs to run after `install-platform`,
since you need to pass `assign-platform` the platform name, for example:

      [root@headnode (coal) ~]# sdcadm experimental assign-platform 20141126T231525Z 564dc9e5-fcb0-fed8-570d-ca17753dd0cc
      updating headnode 564dc9e5-fcb0-fed8-570d-ca17753dd0cc to 20141126T231525Z
      Setting boot params for 564dc9e5-fcb0-fed8-570d-ca17753dd0cc
      Updating booter cache for servers
      Done updating booter caches

Remember that you can review the list of available platforms by
running:

    sdc-cnapi /platforms | json -Ha

## sdcadm experimental add-new-agent-svcs

Create SAPI services for new global zone agents, if required.

    sdcadm experimental add-new-agents-svc

## sdcadm experimental update-other

This subcommand is used to perform little modifications of SDC setups,
like resolvers, DNS for new services, add region names, ...

    sdcadm experimental update-other

The command will take care of updating only those things which have been
added to SDC since the global zone was built:

    [root@headnode (coal) ~]# sdcadm experimental update-other
    Updating maintain_resolvers for all vm services
    Updating DNS domain service metadata for papi, mahi
    Updating DNS domain SDC application metadata for papi, mahi
    No need to update region_name for this data center
    sapi_domain already present on node.config
    Done.

## sdcadm experimental update-gz-tools

Update the SDC Global Zone Tools.

Usage:

     sdcadm experimental update-gz-tools IMAGE-UUID
     sdcadm experimental update-gz-tools PATH-TO-INSTALLER
     sdcadm experimental update-gz-tools --latest

You can see the available gz-tools images by running:

    updates-imgadm list name=gz-tools

And then use the image uuid the same way than the following example:


    [root@headnode (coal) ~]# sdcadm experimental update-gz-tools 94070fee-22f1-439e-9ae8-7879012edceb
    Downloading gz-tools image 94070fee-22f1-439e-9ae8-7879012edceb (2.0.0) to /var/tmp/gz-tools-94070fee-22f1-439e-9ae8-7879012edceb-24644.tgz
    Decompressing gz-tools tarball
    Updating "sdc" zone tools
    Updating global zone scripts
    Mounting USB key
    Unmounting USB key
    Updating cn_tools on all compute nodes
    Cleaning up gz-tools tarball
    Updated gz-tools successfully (elapsed 22s).

## sdcadm experimental update-agents

Update SDC agents

Usage:

     sdcadm experimental update-agents IMAGE-UUID
     sdcadm experimental update-agents PATH-TO-INSTALLER
     sdcadm experimental update-agents --latest

Once more, you can see the available agents images by running:

    updates-imgadm list name=agentsshar

#### Ideas for the future:

- dev-headnode-provisionable: make headnode provisionable
- dev-local-image-creation: allow local custom image creation
- imgapi-manta: setup imgapi to use a manta for custom image creation
  (see also: dev-local-image-creation)
- dev: add some fake data (users, packages) to practically play with the system (see GH#1).
- dev: setup amon email and/or xmpp notifications

# Configuration

Configuration files and vars for `sdcadm` are described in this section.
The runtime `sdcadm` config is loaded as follows:

1. Load defaults from "/opt/smartdc/sdcadm/etc/defaults.json".
2. Load and merge in values from "/var/sdcadm/sdcadm.conf" (JSON format), if
   that exists.
3. Load some SDC config data via `bash /lib/sdc/config.sh -json`.

Config vars are as follows:

| var              | description                                                                                                                                                           |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| updatesServerUrl | Default: `https://updates.joyent.com`. The server from which update images/packages are retrieved.                                                                    |
| vmMinPlatform    | A minimum supported platform version on which `sdcadm` supports deploying/updating VM instances. Currently the minimum is a platform build including the OS-2275 fix. |
| serverUuid       | Typically set (on node setup) to the server's UUID. This is used for identification in the user-agent string.                                                         |
