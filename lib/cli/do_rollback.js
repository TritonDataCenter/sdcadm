/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

var p = console.log;
var fs = require('fs');
var path = require('path');

var vasync = require('vasync');

var common = require('../common');
var errors = require('../errors');

/*
 * The 'sdcadm rollback' CLI subcommand.
 */

function do_rollback(subcmd, opts, _args, cb) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    }

    // TODO: When no file is given, read latest from /var/sdcadm/updates
    // (or maybe just add '--latest' option, like for platform cmd)
    if (!opts.file) {
        cb(new errors.UsageError('File including update plan ' +
                    'to rollback must be specified'));
        return;
    }

    if (!opts.force) {
        cb(new errors.UsageError('Migrations and version ' +
            'dependencies not implemented. Use "--force" to rollback ' +
            '(warning: you know what you are doing w.r.t. migrations).'));
        return;
    }

    var upPlan;
    var plan;
    var unlock;
    var execStart;

    vasync.pipeline({funcs: [
        function getSpecFromFile(_, next) {
            fs.readFile(opts.file, {
                encoding: 'utf8'
            }, function rfCb(err, data) {
                if (err) {
                    // TODO: InternalError
                    next(err);
                    return;
                }
                upPlan = JSON.parse(data);  // presume no parse error
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
        function genRbPlan(_, next) {
            self.sdcadm.genRollbackPlan({
                updatePlan: upPlan
            }, function (err, _plan) {
                if (err) {
                    next(err);
                    return;
                }
                plan = _plan;
                next();
            });
        },

        function confirm(_, next) {
            if (plan.procs.length === 0) {
                next();
                return;
            }
            p('');
            p('This rollback will make the following changes:');
            self.sdcadm.summarizePlan({plan: plan, progress: self.progress});
            p('');
            if (opts.yes) {
                next();
                return;
            }
            var msg = 'Would you like to continue? [y/N] ';
            common.promptYesNo({msg: msg, default: 'n'}, function (answer) {
                if (answer !== 'y') {
                    p('Aborting rollback');
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
                dryRun: opts.dry_run,
                uuid: self.uuid,
                upDir: path.dirname(opts.file)
            }, next);
        }
    ]
    }, function finishRb(err) {
        vasync.pipeline({funcs: [
            function dropLock(_, next) {
                if (!unlock) {
                    next();
                    return;
                }
                self.sdcadm.releaseLock({unlock: unlock}, next);
            }
        ]}, function done(finishRbErr) {
            // We shouldn't ever get a `finishRbErr`. Let's be loud if we do.
            if (finishRbErr) {
                self.log.fatal({err: finishRbErr},
                    'unexpected error finishing up rollback');
            }
            if (err || finishRbErr) {
                cb(err || finishRbErr);
                return;
            }

            if (plan.procs.length === 0) {
                p('Nothing to rollback');
            } else {
                p('Rolledback successfully (elapsed %ds).',
                    Math.floor((Date.now() - execStart) / 1000));
            }
            cb();
        });
    });
}


do_rollback.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['dry-run', 'n'],
        type: 'bool',
        help: 'Go through the motions without actually rolling back.'
    },
    {
        names: ['yes', 'y'],
        type: 'bool',
        help: 'Answer yes to all confirmations.'
    },
    {
        names: ['force'],
        type: 'bool',
        help: 'Do the rollback despite of migrations and version dependencies'
    },
    {
        names: ['file', 'f'],
        type: 'string',
        help: 'Full path to file with update plan.json to rollback',
        helpArg: 'FILE_PATH'
    }
];


do_rollback.help = (
    'Rollback SDC services and instances.\n' +
    '\n' +
    'Usage:\n' +
    '     {{name}} rollback [<options>] -f <./local-upgrade-file.json> ...\n' +
    '\n' +
    '{{options}}'
);

do_rollback.logToFile = true;

// --- exports

module.exports = {
    do_rollback: do_rollback
};
