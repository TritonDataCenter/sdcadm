/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2019 Joyent, Inc.
 * Copyright 2022 MNX Cloud, Inc.
 */

/*
 * The 'sdcadm post-setup logarchiver' CLI subcommand.
 */


var errors = require('../errors');
var AddServiceProc = require('../procedures/add-service').AddServiceProcedure;
var runProcs = require('../procedures').runProcs;

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
        svcName: svcName,
        packageName: 'sdc_1024',
        delegatedDataset: false,
        networks: [
            {name: 'admin'}
        ],
        firewallEnabled: false
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

    const proc = new AddServiceProc(procOpts);

    runProcs({
        log: self.log,
        procs: [proc],
        sdcadm: self.sdcadm,
        ui: self.ui,
        dryRun: opts.dry_run,
        skipConfirm: opts.yes
    }, cb);
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
            ' the instance. (By default the headnode will be used.)',
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
            'updates.tritondatacenter.com, "current" for the latest image ' +
            'already in the datacenter (if any), or an image UUID or version.'
    },
    {
        names: ['channel', 'C'],
        type: 'string',
        help: 'The updates.tritondatacenter.com channel from which to fetch ' +
            'the image. See `sdcadm channel get` for the default channel.'
    }

];

do_logarchiver.help = [
    'Create the "logarchiver" service and a first instance.',
    '',
    'Usage:',
    '     {{name}} logarchiver',
    '',
    '{{options}}',
    'The "logarchiver" service uploads specific Triton log files to a' +
    ' configured Manta object store.'
].join('\n');

do_logarchiver.logToFile = true;

// --- exports

module.exports = {
    do_logarchiver: do_logarchiver
};

// vim: set softtabstop=4 shiftwidth=4:
