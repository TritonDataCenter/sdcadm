/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 */

/*
 * The 'sdcadm post-setup logarchiver' CLI subcommand.
 */

// var util = require('util');

var vasync = require('vasync');

var common = require('../common');
var errors = require('../errors');
var AddServiceProc = require('../procedures/add-service').AddServiceProcedure;


function do_logarchiver(subcmd, opts, args, cb) {
    var self = this;
    if (opts.help) {
        this.do_help('help', {}, [subcmd], cb);
        return;
    } else if (args.length > 0) {
        cb(new errors.UsageError('too many args: ' + args));
        return;
    }

    const svcName = 'logarchiver';
    const procOpts = {
        svcName: svcName
    };
    if (opts.image) {
        procOpts.image = opts.image;
    }

    if (opts.channel) {
        procOpts.channel = opts.channel;
    }

    if (opts.server) {
        procOpts.server = opts.server;
    }

    const skipConfirm = Boolean(opts.yes);
    let doNothing;
    let start;

    const proc = new AddServiceProc(procOpts);
    const execOpts = {
        sdcadm: self.sdcadm,
        log: self.log,
        ui: self.ui
    };

    vasync.pipeline({funcs: [
        function prepare(_, next) {
            proc.prepare(execOpts, function prepareCb(preErr, nothingToDo) {
                if (preErr) {
                    next(preErr);
                    return;
                }
                doNothing = nothingToDo;
                next();
            });

        },

        function askConfirmation(_, next) {
            if (skipConfirm) {
                next();
                return;
            }

            self.ui.info(proc.summarize());

            if (doNothing) {
                next();
                return;
            }

            const msg = 'Would you like to continue? [y/N] ';
            common.promptYesNo({msg: msg, default: 'n'}, function (answer) {
                if (answer !== 'y') {
                    self.ui.info('Aborting.');
                    next(true);
                    return;
                }
                self.progress('');
                next();
            });
        },
        function execute(_, next) {
            if (opts.dryRun) {
                self.progress('Skipping execution (dry-run).');
                next(true);
                return;
            }
            start = Date.now();
            proc.execute(execOpts, function execCb(execErr) {
                if (execErr) {
                    cb(execErr);
                    return;
                }
                next();
            });
        }
    ]}, function pipeCb(pipeErr) {
        if (pipeErr === true) {
            pipeErr = null;
        }

        if (pipeErr) {
            cb(pipeErr);
            return;
        }

        if (start) {
            const elapsed = Math.floor((Date.now() - start) / 1000);
            self.progress('"%s %s" took (%ds)',
                self.name, svcName, elapsed);
        }
        cb();
    });
}

do_logarchiver.options = [
    {
        names: ['help', 'h'],
        type: 'bool',
        help: 'Show this help.'
    },
    {
        names: ['yes', 'y'],
        type: 'bool',
        help: 'Answer yes to all confirmations.'
    },
    {
        names: ['dry-run', 'n'],
        type: 'bool',
        help: 'Do a dry-run.'
    },
    {
        names: ['server', 's'],
        type: 'string',
        help: 'Either hostname or uuid of the server on which to create' +
            ' the instance. (By default the headnode will be used).',
        helpArg: 'SERVER'
    },
    {
        group: 'Image selection (by default latest image on default ' +
            'channel)'
    },
    {
        names: ['image', 'i'],
        type: 'string',
        help: 'Specifies which image to use for the first instance. ' +
            'Use "latest" (the default) for the latest available on ' +
            'updates.joyent.com, "current" for the latest image already ' +
            'in the datacenter (if any), or an image UUID or version.'
    },
    {
        names: ['channel', 'C'],
        type: 'string',
        help: 'The updates.joyent.com channel from which to fetch the ' +
            'image. See `sdcadm channel get` for the default channel.'
    }

];

do_logarchiver.help = (
    'Create the "logarchiver" service and a first instance.\n' +
    '\n' +
    'Usage:\n' +
    '     {{name}} logarchiver\n' +
    '\n' +
    '{{options}}'
);

do_logarchiver.logToFile = true;

// --- exports

module.exports = {
    do_logarchiver: do_logarchiver
};

// vim: set softtabstop=4 shiftwidth=4:
