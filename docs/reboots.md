<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright 2016 Joyent Inc.
-->


# SDC Compute Node Reboot

## Introduction

One of the least specified and hardest parts of SDC upgrades has been
managing the reboot of CNs and the headnode safely. In particular:

- orderly reboot of the "core" servers (those with SDC core components,
  especially the HA binder and manatee nodes)
- reasonably helpful tooling for rebooting all or subsets of the other servers
  in a controlled fashion

In order to solve this problem, `sdcadm` provides the `reboot-plan` subcommand,
which can be used to create a "specification" of how a collection of servers
should be rebooted and, once the specification has been verified, trigger its
execution.

This specification is called a __"reboot plan"__, a JSON document similar to
the "update plan" used by `sdcadm` to drive updates of SDC components.

This __"reboot plan"__ object has the following properties:

- `uuid`: Unique identifier for the reboot plan.
- `name`: Uninterpreted plan name or description.
- `state` of the reboot plan. One of `created`, `stopped`, `running`,
  `canceled`, `complete`
- `concurrency`: maximum number of servers that can be offline at once
- `reboots`: Collection of servers which will be rebooted.

Each one of these reboot elements can have, in turn, the following properties:

- `server_uuid`: UUID of the server to be rebooted
- `boot_platform`: target platform version for the server to be rebooted into
- `current_platform`: the platform version of the server when the reboot plan
  is created.
- `job_uuid`: UUID of the reboot job, once it has been created through CNAPI
- `state`: Current reboot state, one of `created`, `initiated`, `rebooting`,
  `complete`, `canceled`, `failed`.
- `events`: Array of (free form) reboot events like

        [{
            type: 'reboot_job_started',
            time: ISO 8601 timestamp
        },{
            type: 'reboot_job_finished',
            time: ISO 8601 timestamp
        }


An excerpt of the sdcadm man page including all the `reboot-plan`
[subcommands](#sdcadm-reboot-plan-man-page-excerpt) can be found at the bottom
of this document as a quick reference.

## How reboot plans are created?

A __"reboot plan"__ is created by `sdcadm` through `CNAPI` - see [TODO](#todo)
section for the pending CNAPI documentation regarding available REST end-points
for reboot plans and reboots - using the subcommand `reboot-plan create`. The
following are the options for this command:

    sdcadm experimental reboot-plan create [OPTIONS] [SERVER] [SERVER]...

    Options:

    -h, --help             Show this help.
    -y, --yes              Answer yes to all confirmations.
    -n, --dry-run          Go through the motions without actually rebooting.
    -N N, --rate=N         Number of servers to reboot simultaneously. Default:
                           5.
    -W, --ignore-warnings  Create the reboot plan regardless of warnings emitted
                           for servers already on the target platform, or any
                           other warnings.
    -s, --skip-current     Skip the reboot of servers already on target boot
                           platform.
    -r, --run              Run the reboot-plan right after it is created.
    -w, --watch            Watch the reboot plan execution.

    Server selection:
    --core                 Reboot the servers with SDC core components. Note that
                           this will include the headnode.
    --non-core             Reboot the servers without SDC core components.
    -a, --all              Reboot all the servers.


Here are more details about some of these options:

- `concurrency`: This is the maximum number of servers included on the plan
  which can be offline simultaneously. In other words, the reboots of the
  plan's servers take place in _batches_, each one of them including up to
  `concurrency` servers.
  However, there is an exception to this rule: __if the plan include any core
  servers, these servers will be rebooted before the others, one at a time__.
  The rationale for this arrangement is that the reboot plan is usually executed
  right after SDC upgrades, when the operator prefers to complete the system
  maintenance first, then reboot the rest of the servers at his leisure.
- `ignore-warnings`: When some of the servers selected will reboot using
  exactly the same platform version or a downgraded version, `create-plan` will
  emit a warning with information about these servers and refuse to create the
  reboot plan. To override the warnings, specify the `--ignore-warnings` option.
- `skip-current`: This option is provided to avoid the aforementioned warnings
  by excluding the servers already running on the target platform version.
- `core`: This option can be used to reboot only the servers with SDC core
  components. Whereas every server in SDC runs the SDC agent services in
  its Global Zone, _"core servers"_ are those which, in addition to agent
  services, have zones running SDC services like `manatee`, `binder`,
  `moray` and others. The `headnode` is obviously one of these core
  servers. As mentioned above, the reboot of these core servers will happen
  before the reboot of any other servers, one at a time, regardless of the
  value set for `rate`.
- `non-core`: This option covers all the servers that are not classified as core.
- `all`: Reboot all the servers in the data center, core first, then all non-core.

## What executes a reboot plan?

Reboot plans are created using `sdcadm`'s `reboot-plan create` subcommand
and its execution is triggered with the `reboot-plan run` subcommand,
(or by passing the `-r|--run` option to `reboot-plan create`).

But the actual reboot actions are not executed by `sdcadm` itself. The
responsibility of executing the reboot falls on the `sdcadm-agent`, a 
service running in headnode's Global Zone.

To `watch` or monitor the execution status of the current reboot plan,
use either the `reboot-plan watch` subcommand or the `-w|--watch` option
in the `reboot-plan create` or `reboot-plan run` subcommands.

Sample output for `reboot-plan run --watch`:

        [root@headnode (coal) ~]# sdcadm experimental reboot-plan run $UUID --watch
        Plan execution has been started
        - Rebooted: 0 servers, pending to reboot: 1 servers
        ...servers, 5 max concurrency): [                                                          ]   0%        0
        - Rebooting server zero: platform 20160404T130602Z -> 20160404T130602Z
        - Rebooted server zero: 2016-05-05T12:06:31.814Z - 2016-05-05T12:11:35.000Z (5m3s)
        - Checking server zero is fully operational

        Plan complete. Check sdcadm-reboot-plan logs for the details.
        ...servers, 5 max concurrency): [=========================================================>] 100%        1


Without `--watch`, `reboot-plan run` will not wait for reboot completion:

        [root@headnode (coal) ~]# sdcadm experimental reboot-plan run $UUID
        Plan execution has been started
        [root@headnode (coal) ~]#

The use of a process independent of `sdcadm` command line client is required,
among others, because the reboot of the headnode as part of a reboot plan will
require the sdcadm process itself to exit.

Therefore, any attempt to abort a `reboot-plan` execution using `CTRL + C`
(`SIGINT`) over the `sdcadm`'s command line process will just result in the
`sdcadm` process being exited, along with the instruction on how to actually
cancel the execution of a reboot plan.

If the execution of a reboot plan needs to be interrupted or completely aborted,
`reboot-plan pause` or `reboot-plan cancel` subcommands should be used instead.

Cancelation of a reboot plan means that the plan will finish its execution as
soon as the reboots in progress finish and no more pending reboots will be
executed in the future. Stopping the plan will just pause the plan's execution
when the in-progress reboots finish, but the plan can be resumed in the future
using `reboot-plan run`.

Please note that in both cases, the execution of the reboot plan will be
stopped - temporarily or indefinitely - but in neither case _"in-progress reboots"_
will be aborted in the middle of the reboot job or while checking for services
availability after system reboot.

In other words, once we've sent CNAPI the order to reboot some servers - as many
as we specify through the `concurrency` option - we'll wait for the successful or
failed completion of these servers, despite any interruption attempts. Of course,
once these _"in-progress reboots"_ are finished, the plan will not attempt to
reboot any more servers.

## How a reboot plan is executed?

The following is a detailed description of how reboot plans are executed,
including an explanation of the different steps which will take place during
the reboot of each server.

The `sdcadm-agent` service is a **transient service**. This means that it will
run once, upon headnode boot up, to complete the process of rebooting the
headnode itself and continue with the reboot of other servers in the reboot plan.

But in order to begin the execution of the reboot plan, the service needs
to be restarted. This is done by the `reboot-plan run` subcommand or when the
`--run` option is given to `reboot-plan create`.

Once the service is running, the process begins with `sdcadm-agent` to gather
the information regarding pending (or in progress) reboot-plan from `CNAPI`.
In case a plan is found, and there are pending reboots to be completed as part
of the plan, the execution of one or more reboots (depending on `rate` or if
we are rebooting core servers) will be triggered. The reboot of each server
includes the following steps:

#### 1. Check if we are in the middle of a headnode reboot

If this is the case, we cannot move forward until all the SDC services are up
and running again. The process will therefore wait and check headnode's service
health up to 1 hour (In the future this time may change or be configurable).

#### 2. Check if we are rebooting the server hosting the primary manatee

If we are rebooting the server containing the primary manatee's shard member,
we will __freeze the manatee shard__ until the reboot process for this server
has been completed.

#### 3. Create the reboot job through CNAPI

Now, we'll create the reboot job for our server through a `POST` request to
`/servers/:server_uuid/reboot` with two main differences regarding servers
reboot outside a reboot plan:

  a. When a reboot plan is created, `CNAPI` will refuse to run reboot jobs
     for any servers included in the reboot plan, unless the plan's UUID
     is given as part of the above `POST` request. In other words, CNAPI will
     refuse reboot requests of individual servers that are already covered
     in the reboot plan.

  b. Additionally, we do not want any cn-agent task running in our server while
     we reboot it. As such, we also pass the `drain` option to `CNAPI`. This
     will make cn-agent stop accepting new tasks on this server until the job
     is completed and we `resume` the normal operation of cn-agent.

Once the job is created, the `job_uuid` property is added to the `reboot`
object.

#### 4. Execute the reboot job

Once workflow's runner picks the server reboot job, the following tasks will be
executed:

  a. Add the `started_at` value to the `reboot` record

  b. Pause the `cn-agent` task handler

  c. Wait up to 15 minutes for `cn-agent` to be drained (do not have any
     pending or running task)

  d. Send the reboot command to the server

  e. Mark the server as rebooting

  f. Add the `finished_at` value to the `reboot` record

Note that this job will not wait for successful server reboot, it will just send
the reboot command (`exit 113`).

During the execution of the reboot job, `sdcadm-agent` will poll for job
completion up to 1 hour (In the future this time may change or be configurable).

#### 5. Wait for all the SDC services to be operational in the server

Once the reboot job in the previous step has succeeded, `sdcadm-agent` will now
try to get the health information for all the SDC services running in the server:
Agent services running in the GZ and additionally, in the case of core servers, 
SDC services running in the non-GZ.

This attempt to wait for all the server's SDC services to be healthy will last
up to 1 hour (In the future this time may change or be configurable).

Once all the SDC services are up and running in the server, the
`operational_at` property will be added to the reboot job.

Obviously, this step will not take place again for the headnode, where we
already checked core service health during Step 1.

#### 6. Check manatee's shard state and unfreeze manatee

Finally, if we are rebooting a server running one of the manatee's shard members,
we'll first check that the manatee state and synchronization are OK.

Additionally, if that manatee's shard member is the primary manatee, we'll
unfreeze the manatee shard.

#### 7. Failures

A failure in any of the steps above will result in a `canceled_at` property
added to the reboot object. (Adding some extra explanation of the error cause,
specially when that doesn't happen as part of the reboot job, could be
required here, b/c it could be hard for the user to dig into sdcadm logs
trying to find the reason for a server's reboot failure).

## sdcadm reboot-plan man page excerpt

     sdcadm experimental reboot-plan [options] command [args...]
         Reboot plan related sdcadm commands.

         CLI commands for working towards controlled and safe reboots of selected servers in
         a typical SDC setup.

           sdcadm experimental reboot-plan [OPTIONS] COMMAND [ARGS...]
           sdcadm experimental reboot-plan help COMMAND

         -h, --help
             Show this help message and exit.

     sdcadm experimental reboot-plan [options] create [args...]
         Create a reboot plan.

           sdcadm experimental reboot-plan create [OPTIONS] [SERVER] [SERVER]...

         Use  "--all"  to  reboot  all  the non-core setup servers or pass a specific set of
         SERVERs. A "SERVER" is a server UUID or hostname. In a larger datacenter, getting a
         list of the wanted servers can be a chore. The "sdc-server lookup ..." tool is use-
         ful for this.

         Examples:

           # Reboot all non-core servers.
           sdcadm reboot-plan create --non-core

           # Reboot non-core setup servers with the "pkg=aegean" trait.
           sdcadm reboot-plan create \
               $(sdc-server lookup setup=true traits.pkg=aegean)

           # Reboot non-core setup servers, excluding those with a "internal=PKGSRC" trait.
           sdcadm reboot-plan create \
               $(sdc-server lookup setup=true 'traits.internal!~PKGSRC')

           # One liner to run and watch the reboot plan right after creating it
           sdcadm reboot-plan create --all --run --watch

         -h, --help
             Show this help.

         -y, --yes
             Answer yes to all confirmations.

         -n, --dry-run
             Go through the motions without actually rebooting.

         -C N, --concurrency=N
             Number of servers to reboot simultaneously. Default: 5.

         --name=ARG
             Optional descriptive name for the reboot plan.

         -W, --ignore-warnings
             Create the reboot plan despite of emiting warnings for servers already
             on the target platform (or other warnings).

         -s, --skip-current
             Use to skip reboot of servers already on target boot platform.

         Server selection:

         --core
             Reboot the servers with SDC core components.Note that this will
             include the headnode.

         --non-core
             Reboot the servers without SDC core components.

         -a, --all
             Reboot all the servers.

         -r, --run
             Run the reboot-plan right after create it.

         -w, --watch
             Watch the reboot plan execution.

     sdcadm experimental reboot-plan [options] run
         Execute the given reboot plan.

         Note that only a single plan can be running at time.

           sdcadm experimental reboot-plan run PLAN_UUID [OPTIONS]

         -h, --help
             Show this help.

         -w, --watch
             Watch for execution of the plan once it has been started.

     sdcadm experimental reboot-plan [options] next
         Execute the next step of the given reboot plan.

         Like "run" but only the next step of the reboot plan will be executed.

         Note that only a single plan can be running at time.

           sdcadm experimental reboot-plan next PLAN_UUID [OPTIONS]

         -h, --help
             Show this help.

         -w, --watch
             Watch for execution of the plan's step.

     sdcadm experimental reboot-plan [options] status
         Show status of the given reboot plan.

           sdcadm experimental reboot-plan status PLAN_UUID [OPTIONS]

         -h, --help
             Show this help.

     sdcadm experimental reboot-plan [options] watch
         Watch (and wait for) the currently running reboot plan.

           sdcadm experimental reboot-plan watch [OPTIONS]

         -h, --help
             Show this help.

     sdcadm experimental reboot-plan [options] pause
         Pause execution of the currently running reboot plan.

           sdcadm experimental reboot-plan pause [OPTIONS]

         -h, --help
             Show this help.

     sdcadm experimental reboot-plan [options] cancel
         Cancel the given reboot plan.

           sdcadm experimental reboot-plan cancel PLAN_UUID [OPTIONS]

         -h, --help
             Show this help.

## TODO

- Add the following end-points documentation to `CNAPI`:
  * `GET /reboot-plans`
  * `POST /reboot-plans`
  * `GET /reboot-plans/:reboot_plan_uuid`
  * `PUT /reboot-plans/:reboot_plan_uuid`
  * `DELETE /reboot-plans/:reboot_plan_uuid`
  * `GET /reboot-plans/:reboot_plan_uuid/reboots/:reboot_uuid`
  * `PUT /reboot-plans/:reboot_plan_uuid/reboots/:reboot_uuid`
- Make a decision on archiving or not reboot-plans information:
  * Keep all the reboot-plan information in moray, do not archive?
  * Keep information in moray, but delete some data after a given time period?
  * Archive this information and just keep the latest plan in moray?
  * Put archived information in manta?
  * Use sdcadm to put info in manta? Means adding a dependency to sdcadm +
     we may have SDC setups w/o manta - what to do on these cases?
  * Archive reboot plans information from `sdc` zone?
- Depending on this decision on archiving or not information, we may want to
  provide `sdcadm reboot-plan` with some extra tool set to report information
  regarding previous reboot plans, reboots for a given server, ...
