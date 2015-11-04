/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2015, Joyent, Inc.
 */

/*
 * The 'sdcadm update' CLI subcommand.
 */

var p = console.log;

var assert = require('assert-plus');
var vasync = require('vasync');

var errors = require('../errors');
var common = require('../common');

// --- Internal support stuff which can be shared between
// 'sdcadm up' and 'sdcadm experimental up'

function Update(opts) {
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

Update.prototype.name = 'update';

Update.prototype.execute = function cExecute(opts, args, cb) {
    assert.object(opts, 'opts');
    assert.object(args, 'args');
    assert.func(cb, 'cb');

    var self = this;

    var unlock;
    var changes;
    var plan;
    var execStart;

    // Set or override the default channel if anything is given:
    if (opts.channel) {
        self.sdcadm.updates.channel = opts.channel;
    }

    vasync.pipeline({funcs: [
        /**
         * Also see 'sdcadm update' section in docs/index.md.
         *
         *      sdcadm update <svc> ...
         *      sdcadm update <svc>@<image> ...
         *      sdcadm update <svc>@<version> ...
         *      sdcadm update <inst> ...
         *      sdcadm update <inst>@<image> ...
         *      sdcadm update <inst>@<version> ...
         *      sdcadm -f <upgrade-spec-file.json>
         *      echo <upgrade-spec-file.json> | sdcadm update
         *      sdcadm update -a|--all
         *
         * Where a <svc> is one from `sdcadm.getServices()` and <inst> is one
         * of "<zone-uuid>", "<zone-alias>" or "<server-uuid>/<agent-svc>".
         *
         * TODO: Do we need the stdin option?
         *
         *      [
         *          {"service": "cnapi", "image": "<uuid-or-local-path>"},
         *          {"service": "provisioner", "image": "<uuid-or-local-path>"},
         *          ...
         *      ]
         */
        function getChangesFromStdin(_, next) {
            if (args.length !== 0 || opts.all) {
                return next();
            } else if (process.stdin.isTTY) {
                return next(new errors.UsageError(
                    'If updating all instances, --all is a required option.'));
            }
            var chunks = [];
            process.stdin.setEncoding('utf8');
            process.stdin.on('readable', function () {
                var chunk = process.stdin.read();
                if (chunk) {
                    chunks.push(chunk);
                }
            });
            process.stdin.on('end', function () {
                try {
                    changes = JSON.parse(chunks.join(''));
                } catch (ex) {
                    return next(new errors.UsageError(ex,
                        'input is not valid JSON'));
                }
                if (!Array.isArray(changes)) {
                    changes = [changes];
                }
                next();
            });
        },
        function getLock(_, next) {
            self.sdcadm.acquireLock({
                progress: self.progress
            }, function (lockErr, unlock_) {
                unlock = unlock_;
                next(lockErr);
            });
        },
        function getChangesFromArgs(_, next) {
            if (changes) {
                return next();
            }
            self.cli._specFromArgs(opts, args, function (err, chgs) {
                if (err) {
                    return next(err);
                }
                changes = chgs;
                return next();
            });
        },
        function genPlan(_, next) {
            self.log.debug('genPlan');
            self.sdcadm.genUpdatePlan({
                forceDataPath: opts.force_data_path,
                forceRabbitmq: opts.force_rabbitmq,
                forceSameImage: opts.force_same_image,
                forceBypassMinImage: opts.force_bypass_min_image,
                changes: changes,
                justImages: opts.just_images,
                updateAll: opts.all,
                progress: self.progress,
                uuid: self.uuid
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
            p('This update will make the following changes:');
            self.sdcadm.summarizePlan({plan: plan, progress: self.progress});
            p('');
            if (opts.yes) {
                return next();
            }
            var msg = 'Would you like to continue? [y/N] ';
            common.promptYesNo({msg: msg, default: 'n'}, function (answer) {
                if (answer !== 'y') {
                    p('Aborting update');
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
                dryRun: opts.dry_run,
                justImages: opts.just_images,
                uuid: self.uuid
            }, next);
        }

    ]}, function finishUp(err) {
        vasync.pipeline({funcs: [
            function dropLock(_, next) {
                if (!unlock) {
                    return next();
                }
                self.sdcadm.releaseLock({unlock: unlock}, next);
            }
        ]}, function done(finishUpErr) {
            // We shouldn't ever get a `finishUpErr`. Let's be loud if we do.
            if (finishUpErr) {
                self.log.fatal({err: finishUpErr},
                    'unexpected error finishing up update');
            }
            if (err || finishUpErr) {
                return cb(err || finishUpErr);
            }

            if (plan.procs.length === 0) {
                if (opts.just_images) {
                    p('Up-to-date (all images are imported).');
                } else {
                    p('Up-to-date.');
                }
            } else {
                p('Updated successfully (elapsed %ds).',
                    Math.floor((Date.now() - execStart) / 1000));
            }
            cb();
        });
    });

};


// --- CLI
function do_update(subcmd, opts, args, cb) {
    var self = this;

    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    }

    var proc = new Update({
        sdcadm: self.sdcadm,
        log: self.log,
        uuid: self.uuid,
        progress: self.progress,
        cli: self
    });
    proc.execute(opts, args, cb);
}


do_update.aliases = ['up'];
do_update.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['dry-run', 'n'],
        type: 'bool',
        help: 'Go through the motions without actually updating.'
    },
    {
        names: ['all', 'a'],
        type: 'bool',
        help: 'Update all instances.'
    },
    {
        names: ['yes', 'y'],
        type: 'bool',
        help: 'Answer yes to all confirmations.'
    },
    {
        names: ['just-images', 'I'],
        type: 'bool',
        help: 'Just import images. Commonly this is used to preload images ' +
              'before the full upgrade run.'
    },
    {
        names: ['force-data-path'],
        type: 'bool',
        help: 'Upgrade components in the customer data path (portolan)'
    },
    {
        names: ['force-rabbitmq'],
        type: 'bool',
        help: 'Forcibly update rabbitmq (which is not updated by default)'
    },
    {
        names: ['force-same-image'],
        type: 'bool',
        help: 'Allow update of an instance(s) even if the target image is ' +
              'the same as the current.'
    },
    {
        names: ['force-bypass-min-image'],
        type: 'bool',
        help: 'Allow update of an instance(s) even if the target image is ' +
              'unknown or it does not fulfil the minimum image ' +
              'requirements for updates.'
    },
    {
        names: ['channel', 'C'],
        type: 'string',
        help: 'Use the given channel to fetch the image(s), even if it is ' +
            'not the default one.'
    },
    {
        names: ['exclude', 'x'],
        type: 'arrayOfString',
        help: 'Exclude the given services (only when -a|--all is provided)' +
              'Both multiple values (-x svc1 -x svc2) or a single comma ' +
              'separated list (-x svc1,svc2) of service names to be excluded' +
              ' are supported.'
    }
];

do_update.help = (
    'Update SDC services and instances.\n' +
    '\n' +
    'Usage:\n' +
    '     ...update spec on stdin... | {{name}} update [<options>]\n' +
    '     {{name}} update [<options>] <svc> ...\n' +
    '     {{name}} update [<options>] <svc>@<image> ...\n' +
    '     {{name}} update [<options>] <svc>@<version> ...\n' +
    '     {{name}} update [<options>] <inst> ...\n' +
    '     {{name}} update [<options>] <inst>@<image> ...\n' +
    '     {{name}} update [<options>] <inst>@<version> ...\n' +
    '\n' +
    'Examples:\n' +
    '     # Update all instances of the cnapi service to the latest\n' +
    '     # available image.\n' +
    '     {{name}} update cnapi\n' +
    '\n' +
    '     TODO: other calling forms\n' +
    '\n' +
    '{{options}}'
);

do_update.logToFile = true;

//---- exports

module.exports = {
    do_update: do_update
};
