/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2018 Joyent, Inc.
 */

var p = console.log;
var util = require('util');

var assert = require('assert-plus');
var vasync = require('vasync');

var common = require('../common');
var errors = require('../errors');
var steps = require('../steps');

/*
 * The 'sdcadm create' CLI subcommand.
 */

function Create(opts) {
    assert.object(opts, 'opts');
    assert.object(opts.cli, 'opts.cli');
    assert.object(opts.log, 'opts.log');
    assert.object(opts.sdcadm, 'opts.sdcadm');
    assert.func(opts.progress, 'opts.progress');
    assert.string(opts.uuid, 'opts.uuid');

    this.log = opts.log;
    this.sdcadm = opts.sdcadm;
    this.progress = opts.progress;
    this.uuid = opts.uuid;
    this.cli = opts.cli;
}

Create.prototype.name = 'create';

Create.prototype.execute = function cExecute(opts, args, cb) {
    assert.object(opts, 'opts');
    assert.object(args, 'args');
    assert.func(cb, 'cb');

    var self = this;

    var unlock;
    var svcs;
    var svcFromName;
    var changes = [];
    var plan;
    var execStart;

    var serverNames = opts.servers || [];
    // In case the deprecated 'server' option is provided, just add it to
    // the new 'servers' option.
    if (opts.server) {
        serverNames.push(opts.server);
    }

    if (serverNames.length === 0) {
        cb(new errors.UsageError(
            'Must specify at least one server via "-s, --servers" option'));
        return;
    }

    var context = {
        sdcadm: self.sdcadm,
        log: self.log,
        serverNames: serverNames
    };

    vasync.pipeline({ arg: context, funcs: [
        function ensureSdcApp(_, next) {
            self.sdcadm.ensureSdcApp({}, function (err) {
                if (err) {
                    next(err);
                    return;
                }
                // Set or override the default channel if anything is given:
                if (opts.channel) {
                    self.sdcadm.updates.channel = opts.channel;
                }
                next();
            });
        },
        function getLock(_, next) {
            self.sdcadm.acquireLock({progress: self.progress},
                                    function (lockErr, unlock_) {
                unlock = unlock_;
                next(lockErr);
            });
        },

        steps.serversServersFromServerNames, // ctx.serverNames -> ctx.servers
        steps.serversEnsureServersSetup,
        steps.serversEnsureServersRunning,

        function getSvcs(_, next) {
            self.sdcadm.getServices({}, function (err, svcs_) {
                svcs = svcs_;
                svcFromName = {};
                var i;
                for (i = 0; i < svcs.length; i += 1) {
                    svcFromName[svcs[i].name] = svcs[i];
                }
                next(err);
            });
        },

        function getChangeFromArgs(ctx, next) {
            if (args.length === 0) {
                next(new errors.UsageError(
                    'Must specify service name or uuid'));
                return;
            }

            var service = args[0];
            var change = {};
            if (svcFromName[service] === undefined) {
                next(new errors.UsageError(
                    'unknown service: ' + service));
                return;
            }

            change.servers = ctx.servers.map(function (s) { return s.uuid; });
            change.service = args[0];

            if (opts.image) {
                change.image = opts.image;
            } else if (svcFromName[service].params) {
                change.image = svcFromName[service].params.image_uuid;
            }

            /*
             * TOOLS-1719: Fail graceful if service doesn't have an associated
             * image, instead of downloading the latest available image for
             * service
             */
            if (!change.image) {
                next(new errors.ValidationError(util.format(
                    'Missing image_uuid for service %s in SAPI.', service)));
                return;
            }

            change.type = 'create-instances';
            changes.push(change);
            next();
        },

        function genPlan(_, next) {
            self.log.debug('genPlan');
            self.sdcadm.genUpdatePlan({
                changes: changes,
                progress: self.progress,
                uuid: self.uuid,
                skipHACheck: opts.dev_allow_multiple_instances,
                forceDataPath: true
            }, function (err, plan_) {
                plan = plan_;
                next(err);
            });
        },
        function confirm(_, next) {
            if (plan.procs.length === 0) {
                next();
                return;
            }
            p('');
            p('This command will make the following changes:');
            self.sdcadm.summarizePlan({plan: plan, progress: self.progress});
            p('');
            if (opts.yes) {
                next();
                return;
            }
            var msg = 'Would you like to continue? [y/N] ';
            common.promptYesNo({msg: msg, default: 'n'}, function (answer) {
                if (answer !== 'y') {
                    p('Aborting');
                    cb();
                    return;
                }
                p('');
                next();
            });
        },
        function execPlan(_, next) {
            execStart = Date.now();
            if (plan.procs.length === 0) {
                next();
                return;
            }
            if (opts.dry_run) {
                p('[dry-run] done');
                next();
                return;
            }
            self.sdcadm.execUpdatePlan({
                plan: plan,
                progress: self.progress,
                uuid: self.uuid
            }, next);
        }
    ]}, function finishCreate(err) {
        vasync.pipeline({funcs: [
            function dropLock(_, next) {
                if (!unlock) {
                    next();
                    return;
                }
                self.sdcadm.releaseLock({unlock: unlock}, next);
            }
        ]}, function done(finishCreateErr) {
            // We shouldn't ever get a `finishCreateErr`.
            // Let's be loud if we do.
            if (finishCreateErr) {
                self.log.fatal({err: finishCreateErr},
                    'unexpected error finishing create');
            }
            if (err || finishCreateErr) {
                cb(err || finishCreateErr);
                return;
            }

            if (plan.procs.length === 0) {
                p('No-op.');
            } else {
                p('Created successfully (elapsed %ds).',
                    Math.floor((Date.now() - execStart) / 1000));
            }
            cb();
        });
    });
};


Create.prototype.help = (
    'Create one or more instances for an existing SDC service.\n' +
    '\n' +
    'Usage:\n' +
    '       {{name}} create <svc>\n\n' +
    'Note that in order to create an instance of some services the option\n' +
    '--dev-allow-multiple-instances must be specified, given that those\n' +
    'services are not supposed to have more than one instance. There are\n' +
    'also some services whose instances should not be created using\n' +
    'this tool, like manatee or binder. Finally, the first instance of some\n' +
    'services should not be created using this tool when there is an\n' +
    'alternate choice provided by post-setup subcommand.\n'
);


// --- CLI

function do_create(subcmd, opts, args, cb) {
    var self = this;

    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    }

    var proc = new Create({
        sdcadm: self.sdcadm,
        log: self.log,
        uuid: self.uuid,
        progress: self.progress,
        cli: self
    });
    opts.experimental = false;
    proc.execute(opts, args, cb);
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
        names: ['image', 'i'],
        type: 'string',
        help: 'UUID of the Image to be used for the instance.'
    },
    {
        names: ['channel', 'C'],
        type: 'string',
        help: 'Use the given channel to fetch the image, even if it is ' +
            'not the default one.'
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
    }
];

do_create.help = (
    Create.prototype.help +
    '\n' +
    '{{options}}'
);

do_create.logToFile = true;


// --- exports

module.exports = {
    do_create: do_create
};
