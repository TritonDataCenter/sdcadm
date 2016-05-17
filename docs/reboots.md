<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright 2016 Joyent Inc.
-->

# SDC Compute Nodes Reboot

## Introduction

One of the least specified and hardest parts of SDC upgrades has been
managing the reboots of CNs and the headnode safely. In particular:

- controlling reboots of the "core" servers (those with SDC core components,
  esp. the HA binders and manatees)
- reasonably helpful tooling for rebooting (subsets of) the other servers in a
  DC: rolling reboots, reboot rates

In order to solve this problem, `sdcadm` provides the `reboot-plan` subcommand,
which can be used to create "a specification" of how a collection of servers
should be rebooted and, once we're OK with such specification, trigger its
execution.

This specification is called a __"reboot plan"__, a JSON document similar to
the "update plan" used by `sdcadm` to drive updates of SDC components.

This __"reboot plan"__ object has the following properties:

- `uuid`: Unique identifier for the reboot plan.
- `state` of the reboot plan. One of `created`, `stopped`, `running`,
  `canceled`, `complete`
- `concurrency`: maximum number of servers that can be offline at once
- `reboots`: Collection of servers which will be rebooted.

Each one of these reboot elements can have, in turn, the following properties:

- `server_uuid`: UUID of the server to be rebooted
- `server_hostname`: hostname of the server
- `boot_platform`: target boot platform for the server to be rebooted into
- `current_platform`: the platform of the server when the reboot plan is
  created.
- `headnode`: Boolean value. `true` only for a headnode.
- `job_uuid`: UUID of the reboot job, once it has been created through CNAPI
- `started_at`: ISO 8601 timestamp. When the reboot job has started.
- `finished_at`: ISO 8601 timestamp. When the reboot job finished, it's to say,
  when the reboot command was sent to the server
- `operational_at`: ISO 8601 timestamp. When the server reboot has been
  completed, including reporting all the core services running either into the
  Global Zone, or into any core VMs hosted into a core server.
- `canceled_at`: ISO 8601 timestamp. In case the reboot failed or was canceled
  due to some reason, when this happened.

There's an excerpt of the sdcadm man page including all the `reboot-plan`
subcommands at the bottom of this document which can be used as quick reference
while reading it w/o having to switch to the cmdln prompt.

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
    -W, --ignore-warnings  Create the reboot plan despite of emiting warnings
                           for servers already on the target platform (or other
                           warnings).
    -s, --skip-current     Use to skip reboot of servers already on target boot
                           platform.
    -r, --run              Run the reboot-plan right after create it.
    -w, --watch            Watch the reboot plan execution.

    Server selection:
    --core                 Reboot the servers with SDC core components.Note that
                           this will include the headnode.
    --non-core             Reboot the servers without SDC core components.
    -a, --all              Reboot all the servers.


Some of these options might require extra clarification:

- `rate`: This is the maximum number of servers included on the plan which can
  be offline simultaneously. Therefore, the reboots of the plan's servers will
  take place in _batches_, each one of them including up to `rate` servers.
  However, there's an exception to this rule: __if the plan include any core
  servers, the reboot of these will happen before any others, and just one
  core server at time__.
  In many cases the reboot plan will run right after core service upgrades.
  It's desirable to get out of maint soon and get into _"the system itself is
  up to latest"; you can now reboot non-core CNs at leisure_.
- `ignore-warnings`: Either if some of the servers selected will reboot using
  exactly the same platform version or if some servers will reboot into a
  downgraded version, `create-plan` will emit a warning with information about
  these servers and refuse to create the reboot plan. For the cases where a
  reboot using a downgraded platform version, or even reboot into the current
  version is required, it's necessary to specify `--ignore-warnings` option.
- `skip-current`: This option is provided to avoid the aforementioned warnings
  by excluding the servers already running the target platform version either
  if a list of servers is provided as arguments, or when any of the server
  selection options are given.
- `core`: Option can be used to reboot only the servers with SDC core
  components. Although every server setup in SDC runs the SDC Agent
  services into the Global Zone, _"core servers"_ are those where, additionally
  to these agents, there are VMs running SDC services like `manatee`, `binder`,
  `moray` or any others. Obviously, the `headnode` is one of these core
  servers. As mentioned above, the reboot of these core servers will happen
  before the reboot of any other servers, and sequentially, one at time,
  despite of the value given to `rate`.
- `non-core`: All servers but those included into the above item.
- `all`: Reboot all the servers into the DC, core first, then all non-core.


## What executes a reboot plan?

Reboot plans are created through using `sdcadm`'s `reboot-plan create`
subcommand and its execution is triggered by `reboot-plan run` subcommand,
(or by passing the `-r|--run` option to `reboot-plan create`).

But they're not executed by `sdcadm` itself. Execution is a responsibility of
`sdcadm-agent`, a service running into headnode's Global Zone.

There's anyway the option to `watch` the execution of the current reboot plan
using either `reboot-plan watch` subcommand or by passing the `-w|--watch`
option to `reboot-plan create` or `reboot-plan run`.

Sample output for `reboot-plan run --watch`:

        [root@headnode (coal) ~]# sdcadm experimental reboot-plan run --watch
        Plan execution has been started
        - Rebooted: 0 servers, pending to reboot: 1 servers
        ...servers, 5 max concurrency): [                                                          ]   0%        0
        - Rebooting server zero: platform 20160404T130602Z -> 20160404T130602Z
        - Rebooted server zero: 2016-05-05T12:06:31.814Z - 2016-05-05T12:11:35.000Z (5m3s)
        - Checking server zero is fully operational

        Plan complete. Check sdcadm-reboot-plan logs for the details.
        ...servers, 5 max concurrency): [=========================================================>] 100%        1

Without `--watch` will not wait for reboots completion:

        [root@headnode (coal) ~]# sdcadm experimental reboot-plan run
        Plan execution has been started
        [root@headnode (coal) ~]#

Usage of a process independent of `sdcadm` command line client is required,
among others, because the reboot of the headnode as part of a reboot plan will
require the sdcadm process itself to be exited.

Therefore, any attempt to abort a `reboot-plan` execution using `CTRL + C`
(`SIGINT`) over the `sdcadm`'s command line process will result just into
such process being exited together with an explanatory message of what needs
to be done in order to cancel the execution of a reboot plan.

In case that the execution of a reboot plan needs to be interrupted or
completely aborted, `reboot-plan stop` or `reboot-plan cancel` subcommands can
be used.

Cancelation of a reboot plan means that the plan will finish its execution as
soon as the reboots in progress finish and no more pending reboots will be
executed in the future. Stopping the plan will just stop plan's execution when
the in-progress reboots finish, but the plan can be continued in the future
using `reboot-plan run`.

Please note that in both cases, the execution of the reboot plan will be
stopped - temporary or definitely - but in neither case _"in-progress reboots"_
will be aborted in the middle of the reboot job or while checking for services
availability after system reboot.

It's to say, once we've sent CNAPI the order to reboot some servers - as many
as we specify through the `rate` option - we'll wait for the successful or
failed completion of these, despite of any interruptions attempts. Of course,
once these _"in-progress reboots"_ are finished, the plan will not attempt to
reboot any more servers.

## How a reboot plan is executed?

The following is a detailed description of how reboot plans are executed,
including and explanation of the different steps which will take place during
the reboot of each server.

The `sdcadm-agent` service is a **transient service**. This means that it will
run once, on headnode's boot, which is how it'll complete the process of
rebooting the headnode itself and continue after headnode's reboot with any
additionally servers included into the reboot plan.

But, in order to begin with the execution of the reboot plan, the service needs
to be restarted. This is done by the `reboot-plan run` subcommand or when the
`--run` option is given to `reboot-plan create`.

Once the service is running, the process begins with `sdcadm-agent` getting
information regarding pending (or in progress) reboot-plan from `CNAPI`. In
case a plan is found, and there are pending reboots to be completed as part
of the plan, the execution of one or more reboots (depending on `rate` or if
we are rebooting core servers) will be triggered. The reboot of each server
includes the following steps:

#### 1. Check if we're in the middle of a headnode reboot

If that's the case, we cannot move forward until all the SDC services are up
and running again and, therefore, we'll wait checking headnode's services
health up to 1 hour (In the future this time may change or be configurable).

#### 2. Check if we're rebooting the server hosting the primary manatee

If we're rebooting the server containing the primary manatee's shard member,
we'll __freeze the manatee shard__ until the reboot process for this server
has been completed.

#### 3. Create the reboot job through CNAPI

Now, we'll create the reboot job for our server through a `POST` request to
`/servers/:server_uuid/reboot` with two main differences regarding servers
reboot outside a reboot plan:

  a. When a reboot plan is created, `CNAPI` will refuse running reboot jobs
     for any servers included into the reboot plan, unless the plan's UUID
     is given as part of the above `POST` request. It's to say: CNAPI will
     refuse reboot requests of individual servers that are already covered
     in the reboot plan.
  b. Additionally, we don't want any cn-agent task running in our server while
     we reboot it. Thereby, we also pass the `drain` option to `CNAPI`. This
     will make cn-agent stop accepting new tasks on this server until the job
     is completed and we `resume` cn-agent.

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

Note that this job will not wait for successful server reboot, it'll just send
the reboot command (`exit 113`).

During the execution of the reboot job, `sdcadm-agent` will poll for job
completion up to 1 hour (In the future this time may change or be configurable)

#### 5. Wait for all the SDC services to be operative in the server

Assuming the previous reboot job succeeded, `sdcadm-agent` will now try to get
health information for all the SDC services running into the server: Agent
services running into the GZ for all servers and, if we're rebooting a core
server, status for any of the SDC services running into VMs.

This attempt to wait for all the server's SDC services to be healthy will last
for 1 hour (In the future this time may change or be configurable).

Once all the SDC services are up and running into the server, the
`operational_at` property will be added to the reboot job.

Obviously, this step will not take place again for the headnode, where we
already checked core services health as the first step to be able to continue.

#### 6. Check manatee's shard state and unfreeze manatee

Finally, if we're rebooting a server including one of the manatee's shard
VMs, we'll first check that the manatee state and synchronization are OK.

Additionally, if that manatee's shard member is the primary manatee, we'll
unfreeze the manatee shard.

#### 7. Failures

A failure on any of these steps will result into a `canceled_at` property
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
