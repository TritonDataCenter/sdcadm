/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

/*
 * The 'sdcadm create' CLI subcommand.
 */

var util = require('util');

var assert = require('assert-plus');
var vasync = require('vasync');

var errors = require('../errors');
var Procedure = require('../procedures/procedure').Procedure;
var runProcs = require('../procedures').runProcs;
var steps = require('../steps');


function CreateInstanceProcedure(opts) {
    assert.string(opts.svcName, 'opts.svcName');
    assert.arrayOfString(opts.serverNames, 'opts.serverNames');
    assert.ok(opts.serverNames.length > 0, 'at least one server name');
    assert.optionalUuid(opts.imageUuid, 'opts.imageUuid');
    assert.optionalString(opts.imageChannel, 'opts.imageChannel');
    assert.optionalBool(opts.skipHACheck, 'opts.skipHACheck');

    this.svcName = opts.svcName;
    this.serverNames = opts.serverNames;
    this.imageUuid = opts.imageUuid;
    this.imageChannel = opts.imageChannel;
    this.skipHACheck = Boolean(opts.skipHACheck);
}
util.inherits(CreateInstanceProcedure, Procedure);

CreateInstanceProcedure.prototype.prepare = function prepare(opts, cb) {
    assert.object(opts.sdcadm, 'opts.sdcadm');
    assert.object(opts.ui, 'opts.ui');
    assert.object(opts.log, 'opts.log');

    var log = opts.log;
    var sdcadm = opts.sdcadm;
    var self = this;
    var ui = opts.ui;

    vasync.pipeline({arg: {}, funcs: [
        sdcadm.ensureSdcApp.bind(sdcadm),

        function gatherServiceInfo(_, next) {
            ui.info('Gathering SAPI service data');
            sdcadm.getSvc({
                app: 'sdc',
                svc: self.svcName
            }, function (err, svc) {
                if (err) {
                    next(err);
                } else {
                    self.svc = svc;
                    next();
                }
            });
        },

        function gatherServerInfo(_, next) {
            ui.info('Gathering server data');
            steps.servers.selectServers({
                log: log,
                sdcadm: sdcadm,
                includeServerNames: self.serverNames
            }, function selectedServers(err, servers) {
                self.servers = servers;
                next(err);
            });
        },

        function determineImage(ctx, next) {
            // Set or override the default channel if anything is given.
            //
            // Dev Note: The way we set the channel indirectly here is too
            // subtle. It would be better to improve image resolution to
            // pass the channel explicitly through.
            if (this.imageChannel) {
                sdcadm.updates.channel = this.imageChannel;
            }

            ctx.image = null;
            if (this.imageUuid) {
                ctx.image = opts.imageUuid;
            } else {
                // Default to the set `image_uuid` on the SAPI service.
                if (!self.svc.params || !self.svc.params.image_uuid) {
                    next(new errors.ValidationError(util.format(
                        'SAPI "%s" service is missing params.image_uuid',
                        self.svc.name)));
                    return;
                }
                ctx.image = self.svc.params.image_uuid;
            }

            next();
        },

        function generatePlan(ctx, next) {
            var change = {
                type: 'create-instances',
                service: self.svcName,
                servers: self.servers.map(function (s) { return s.uuid; }),
                image: ctx.image
            };
            log.debug({change: change}, 'CreateInstanceProcedure change');

            sdcadm.genUpdatePlan({
                changes: [change],
                progress: ui.progressFunc(),
                skipHACheck: self.skipHACheck,
                forceDataPath: true
            }, function (err, plan) {
                self.plan = plan;
                next(err);
            });
        }
    ]}, function finish(err) {
        cb(err, false);
    });
};


CreateInstanceProcedure.prototype.summarize = function summarize() {
    var summaries = this.plan.procs.map(proc => proc.summarize());
    return summaries.join('\n');
};

CreateInstanceProcedure.prototype.execute = function execute(opts, cb) {
    assert.object(opts.sdcadm, 'opts.sdcadm');
    assert.object(opts.ui, 'opts.ui');

    opts.sdcadm.execUpdatePlan(
        {
            plan: this.plan,
            progress: opts.ui.progressFunc()
        },
        cb
    );
};


// --- CLI

function do_create(subcmd, opts, args, cb) {
    var self = this;

    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    } else if (args.length < 1) {
        cb(new errors.UsageError('missing SERVICE argument'));
        return;
    } else if (args.length > 1) {
        cb(new errors.UsageError('too many arguments'));
        return;
    }

    if (opts.servers && opts.server) {
        cb(new errors.UsageError(
            'cannot specify both "--server SERVER" (deprecated) and ' +
            '"--servers SERVERS" options'));
        return;
    }
    var serverNames = opts.servers;
    if (!serverNames && opts.server) {
        serverNames = [opts.server];
    }
    if (!serverNames) {
        cb(new errors.UsageError(
            'must specify at least one server via the "-s, --servers" option'));
        return;
    }

    var procs = [
        new CreateInstanceProcedure({
            svcName: args[0],
            serverNames: opts.servers,
            imageUuid: opts.image,
            imageChannel: opts.channel,
            skipHACheck: opts.dev_allow_multiple_instances
        })
    ];
    runProcs({
        log: self.log,
        procs: procs,
        sdcadm: self.sdcadm,
        ui: self.ui,
        dryRun: opts.dry_run,
        skipConfirm: opts.yes
    }, function done(err) {
        cb(err);
    });
}


do_create.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['dry-run', 'n'],
        type: 'bool',
        help: 'Go through the motions without actually creating.'
    },
    {
        names: ['yes', 'y'],
        type: 'bool',
        help: 'Answer yes to all confirmations.'
    },
    {
        names: ['dev-allow-multiple-instances'],
        type: 'bool',
        help: 'Allow additional instances to be created even if the service ' +
              'is not HA ready (for development purposes).'
    },
    {
        group: 'Instance options'
    },
    {
        names: ['image', 'i'],
        type: 'string',
        help: 'UUID of the service image to use for the new instance(s). ' +
            'By default the image configured on the service (in SAPI) is used.',
        helpArg: 'UUID'
    },
    {
        names: ['channel', 'C'],
        type: 'string',
        help: 'The updates.joyent.com channel from which to fetch the image ' +
            'given in the "--image UUID" option.',
        helpArg: 'CHAN'
    },
    {
        // Deprecated in favour of `-s,--servers`
        names: ['server'],
        type: 'string',
        hidden: true
    },
    {
        names: ['servers', 's'],
        type: 'arrayOfCommaSepString',
        help: 'Comma separated list of servers (either hostnames or uuids) ' +
            'on which to create the instance(s).',
        helpArg: 'SERVERS'
    }
];

do_create.help = (
    'Create one or more instances of an existing Triton VM service.\n' +
    '\n' +
    'Usage:\n' +
    '       {{name}} create SERVICE\n' +
    '\n' +
    '{{options}}' +
    '\n' +
    'Note that in order to create an instance of some services the option\n' +
    '--dev-allow-multiple-instances must be specified, given that those\n' +
    'services are not supposed to have more than one instance. There are\n' +
    'also some services whose instances should not be created using\n' +
    'this tool, like manatee or binder. Finally, the first instance of some\n' +
    'services should not be created using this tool when there is an\n' +
    'alternate choice provided by post-setup subcommand.\n'
);

do_create.logToFile = true;


// --- exports

module.exports = {
    do_create: do_create
};
