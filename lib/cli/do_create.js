/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

var p = console.log;

var vasync = require('vasync');

var common = require('../common');
var errors = require('../errors');

/*
 * The 'sdcadm create' CLI subcommand.
 */

function do_create(subcmd, opts, args, cb) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    }

    var unlock;
    var svcs;
    var svcFromName;
    var changes = [];
    var plan;
    var execStart;

    vasync.pipeline({funcs: [
        function getLock(_, next) {
            self.sdcadm.acquireLock({progress: self.progress},
                                    function (lockErr, unlock_) {
                unlock = unlock_;
                next(lockErr);
            });
        },
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
        function getChangeFromArgs(_, next) {
            if (args.length === 0) {
                return next(new errors.UsageError(
                    'Must specify service name or uuid'));
            }

            var service = args[0];
            var change = {};
            if (svcFromName[service] === undefined) {
                return next(new errors.UsageError(
                    'unknown service: ' + service));
            }

            change.service = args[0];

            if (opts.image) {
                change.image = opts.image;
            } else {
                change.image = svcFromName[service].params.image_uuid;
            }

            if (!opts.server) {
                return next(new errors.UsageError(
                    'Must specify server uuid'));
            }
            change.server = opts.server;
            change.type = 'create';
            changes.push(change);
            next();
        },

        function genPlan(_, next) {
            self.log.debug('genPlan');
            self.sdcadm.genUpdatePlan({
                changes: changes,
                progress: self.progress,
                uuid: self.uuid,
                skipHACheck: opts.skip_ha_check
            }, function (err, plan_) {
                plan = plan_;
                next(err);
            });
        },
        function confirm(_, next) {
            if (plan.procs.length === 0) {
                return next();
            }
            p('');
            p('This command will make the following changes:');
            self.sdcadm.summarizePlan({plan: plan, progress: self.progress});
            p('');
            if (opts.yes) {
                return next();
            }
            var msg = 'Would you like to continue? [y/N] ';
            common.promptYesNo({msg: msg, default: 'n'}, function (answer) {
                if (answer !== 'y') {
                    p('Aborting');
                    return cb();
                }
                p('');
                next();
            });
        },
        function execPlan(_, next) {
            execStart = Date.now();
            if (plan.procs.length === 0) {
                return next();
            }
            if (opts.dry_run) {
                p('[dry-run] done');
                return next();
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
                    return next();
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
                return cb(err || finishCreateErr);
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
        names: ['server', 's'],
        type: 'string',
        help: 'The UUID for the target server.'
    },
    {
        names: ['yes', 'y'],
        type: 'bool',
        help: 'Answer yes to all confirmations.'
    },
    {
        names: ['skip-ha-check'],
        type: 'bool',
        help: 'Allow create the instance even if the service is not ' +
              'HA ready.'
    }
];

do_create.help = (
    'Create an instance for an existing SDC service.\n' +
    '\n' +
    'Usage:\n\n' +
    '       sdcadm create <svc>\n\n' +
    'Note that in order to create an instance of some services the option\n' +
    '--skip-ha-ready must be specified, given that those services are not\n' +
    'supposed to have more than one instance. There are also some services\n' +
    'which are not allowed to have more than one instance, or services\n' +
    'whose instances should not be created using this tool, like manatee or\n' +
    'zookeeper. Finally, the first instance of some services should not be\n' +
    'created using this tool when there is an alternate choice provided by\n' +
    'post-setup subcommand.\n' +
    '\n' +
    '{{options}}'
);

do_create.logToFile = true;

// --- exports

module.exports = {
    do_create: do_create
};
